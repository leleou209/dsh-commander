/**
 * dsh-commander 状态文件存储。
 *
 * 取代 2.9.6 及以前的 Host `storage.form('kv')`（宿主只挂 `domain`，`kv` 必抛
 * `form-not-mounted`，被 catch 后静默降级为内存，重启即丢）。
 *
 * 本模块负责：原子写、0600/0700 权限、跨进程文件锁、损坏隔离（`.broken-<ts>`）、
 * 表修剪、旧版本迁移。不依赖宿主任何服务，可独立单测。
 */
import fsp from 'node:fs/promises'
import { dirname } from 'node:path'

/** 当前 schema 版本（写入 `schema` 字段；`version` 保留为插件版本字符串）。 */
export const STATE_SCHEMA = 3
/**
 * 状态文件的四张表。
 *
 * `takeover` 已于 2.9.19 退役：接管状态改成只在内存里（启动时初始化，不跨进程沿用）。
 * 旧文件里的这张表会在下次写入时自然消失，不需要迁移。
 */
export const STATE_TABLES = ['pending', 'interruptions', 'approvals', 'rounds']

const DEFAULT_MAX_BYTES = 256 * 1024
const DEFAULT_KEEP_PER_TABLE = 200
const DEFAULT_KEEP_DAYS = 90
const DEFAULT_LOCK_WAIT_MS = 2000
const DEFAULT_LOCK_STALE_MS = 30_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 空表结构。 */
export function emptyTables() {
  const tables = {}
  for (const table of STATE_TABLES) tables[table] = {}
  return tables
}

/**
 * 把任意历史格式迁移成当前 schema。
 *
 * 支持：`{ schema, tables }`（3）、`{ version: '2.9.x', tables }`（2.9.7）、
 * 以及没有外层壳、表直接平铺在根上的更老格式。
 */
export function migrateState(parsed) {
  const tables = emptyTables()
  const source = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  const nested = source.tables && typeof source.tables === 'object' && !Array.isArray(source.tables)
  const sourceTables = nested ? source.tables : source
  for (const table of STATE_TABLES) {
    const value = sourceTables[table]
    if (value && typeof value === 'object' && !Array.isArray(value)) tables[table] = value
  }
  let from
  if (typeof source.schema === 'number') {
    if (source.schema !== STATE_SCHEMA) from = `schema ${source.schema}`
  } else if (typeof source.version === 'string' && source.version.length > 0) {
    from = source.version
  }
  return { tables, from, schema: STATE_SCHEMA }
}

/**
 * 创建状态存储。
 * @param {{path: string, pluginVersion?: string, logger?: any, maxBytes?: number, keepPerTable?: number, keepDays?: number, lockWaitMs?: number, lockStaleMs?: number}} options
 */
export async function createStateStore(options) {
  const file = options.path
  const dir = dirname(file)
  const lockFile = `${file}.lock`
  const logger = options.logger ?? {}
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const keepPerTable = options.keepPerTable ?? DEFAULT_KEEP_PER_TABLE
  const keepDays = options.keepDays ?? DEFAULT_KEEP_DAYS
  const lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS
  const lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS

  const state = {
    tables: emptyTables(),
    readError: undefined,
    writeError: undefined,
    migratedFrom: undefined,
    brokenFile: undefined,
    lastWriteAt: undefined,
    exists: false,
    /** 最近一次 flush 是否因锁失败被跳过。 */
    lockBusy: false,
  }

  async function ensureDir() {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
    try {
      await fsp.chmod(dir, 0o700)
    } catch {
      // Windows 不支持 POSIX 权限，忽略
    }
  }

  /** 损坏或超大文件：改名隔离，后续写不会覆盖原数据。 */
  async function quarantine(reason) {
    const backup = `${file}.broken-${Date.now()}`
    try {
      await fsp.rename(file, backup)
      state.brokenFile = backup
    } catch {
      state.brokenFile = undefined
    }
    state.readError = `${reason}${state.brokenFile ? `（原文件已备份到 ${state.brokenFile}）` : ''}`
    state.tables = emptyTables()
    logger.warn?.(`dsh-commander: ${state.readError}`)
    return state
  }

  /** 读取文件；不存在时返回空表。 */
  async function load() {
    try {
      const info = await fsp.stat(file).catch(() => undefined)
      state.exists = Boolean(info)
      if (!info) return state
      if (info.size > maxBytes) return quarantine(`状态文件 ${info.size}B 超过上限 ${maxBytes}B`)
      let raw
      try {
        raw = await fsp.readFile(file, 'utf8')
      } catch (error) {
        state.readError = `读取失败：${error?.message ?? error}`
        return state
      }
      if (raw.trim().length === 0) {
        state.tables = emptyTables()
        return state
      }
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        return quarantine(`JSON 解析失败：${error?.message ?? error}`)
      }
      const migrated = migrateState(parsed)
      state.tables = migrated.tables
      state.migratedFrom = migrated.from
      state.readError = undefined
      return state
    } catch (error) {
      state.readError = `读取失败：${error?.message ?? error}`
      return state
    }
  }

  /** 表修剪：interruptions / rounds 按时间与数量淘汰。 */
  function prune(now = Date.now()) {
    const keepMs = keepDays > 0 ? keepDays * 24 * 3600 * 1000 : 0
    let removed = 0
    for (const table of ['interruptions', 'rounds']) {
      const entries = Object.entries(state.tables[table] ?? {})
      const fresh = entries.filter(([, value]) => {
        if (!keepMs) return true
        const at = Number(value?.at ?? value?.updatedAt ?? 0)
        // 没有时间戳的旧记录保留，避免误删
        return at === 0 ? true : now - at <= keepMs
      })
      fresh.sort(
        (a, b) => Number(b[1]?.at ?? b[1]?.updatedAt ?? 0) - Number(a[1]?.at ?? a[1]?.updatedAt ?? 0),
      )
      const kept = fresh.slice(0, keepPerTable)
      removed += entries.length - kept.length
      state.tables[table] = Object.fromEntries(kept)
    }
    return removed
  }

  /** 取跨进程锁；拿不到返回 false（调用方不得覆盖文件）。 */
  async function acquireLock() {
    await ensureDir()
    const deadline = Date.now() + lockWaitMs
    for (;;) {
      try {
        const handle = await fsp.open(lockFile, 'wx', 0o600)
        try {
          await handle.writeFile(`${process.pid} ${Date.now()}\n`)
        } catch {
          // 写不进内容不影响互斥
        }
        await handle.close()
        return true
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        try {
          const info = await fsp.stat(lockFile)
          if (Date.now() - info.mtimeMs > lockStaleMs) {
            await fsp.unlink(lockFile).catch(() => {})
            continue
          }
        } catch {
          // 锁刚好被释放，重试
          continue
        }
        if (Date.now() > deadline) return false
        await sleep(50)
      }
    }
  }

  /** 落盘：修剪 → 加锁 → tmp(0600) → rename → 解锁。 */
  async function flush() {
    prune()
    const locked = await acquireLock()
    if (!locked) {
      state.lockBusy = true
      state.writeError = `另一个进程正在写状态文件（锁 ${lockFile}），本次未覆盖`
      logger.warn?.(`dsh-commander: ${state.writeError}`)
      return false
    }
    state.lockBusy = false
    try {
      const payload = JSON.stringify({
        schema: STATE_SCHEMA,
        version: options.pluginVersion,
        updatedAt: Date.now(),
        tables: state.tables,
      })
      if (Buffer.byteLength(payload, 'utf8') > maxBytes) {
        state.writeError = `状态数据 ${Buffer.byteLength(payload, 'utf8')}B 超过上限 ${maxBytes}B，本次未写入`
        return false
      }
      const tmp = `${file}.${process.pid}.tmp`
      await fsp.writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 })
      try {
        await fsp.chmod(tmp, 0o600)
      } catch {
        // Windows 忽略
      }
      await fsp.rename(tmp, file)
      state.writeError = undefined
      state.lastWriteAt = Date.now()
      state.exists = true
      return true
    } catch (error) {
      state.writeError = `写入失败：${error?.message ?? error}`
      logger.warn?.(`dsh-commander: ${state.writeError}`)
      return false
    } finally {
      await fsp.unlink(lockFile).catch(() => {})
    }
  }

  /** 写一条记录（失败只记 error，不抛：内存里已经是最新值）。 */
  async function put(table, key, value) {
    if (!STATE_TABLES.includes(table)) throw new Error(`dsh-commander: 未知状态表 ${table}`)
    state.tables[table][key] = value
    return flush()
  }

  /** 删一条记录。 */
  async function remove(table, key) {
    if (!STATE_TABLES.includes(table)) return false
    delete state.tables[table][key]
    return flush()
  }

  /** 读一张表的全部记录。 */
  function table(name) {
    return state.tables[name] ?? {}
  }

  /** `--fix`：把目录/文件权限纠正回来。 */
  async function fixPerms() {
    const applied = []
    try {
      await fsp.chmod(dir, 0o700)
      applied.push(`目录 ${dir} → 0700`)
    } catch (error) {
      if (process.platform !== 'win32') applied.push(`目录 chmod 失败：${error?.message ?? error}`)
    }
    try {
      await fsp.chmod(file, 0o600)
      applied.push(`文件 ${file} → 0600`)
    } catch (error) {
      if (error?.code !== 'ENOENT' && process.platform !== 'win32') {
        applied.push(`文件 chmod 失败：${error?.message ?? error}`)
      }
    }
    return applied
  }

  await load()

  return {
    path: file,
    lockPath: lockFile,
    state,
    load,
    flush,
    put,
    remove,
    table,
    prune,
    fixPerms,
    snapshot: () => state,
    counts: () => {
      const counts = {}
      for (const name of STATE_TABLES) counts[name] = Object.keys(state.tables[name] ?? {}).length
      return counts
    },
  }
}