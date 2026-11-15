/**
 * 状态存储：**async 优先**，只给 tools.guard 留一个同步快照。
 *
 * 与老包的关键差别（这是本次简化的核心）：
 *   老包 `currentTakeover()` / `listMembers()` 是同步的，于是长出两套适配器
 *   （按根会话的成员缓存 + store 反向持有 Map + hydrate/ready/负缓存）。
 *   那两个适配器各自造过一个真 bug：重启后「图标不认指挥员」、weak→weak 误暂停 goal。
 *
 *   实际上只有 `tools.guard` 是宿主契约要求的同步入口；HTTP 路由和工具 handler
 *   本来就是 async。所以这里：**一个缓存，两种访问器**，写入同时更新缓存与磁盘。
 *   成员（指挥员在不在）根本不缓存 —— 见 commander.js 的 async 查询。
 *
 * 落盘：临时文件 + rename（同卷原子）；跨进程用 lockfile 串行化。
 * 只存两张表：modes（挡位，跨进程保留）、pending（咨询请求）。
 * 放行/批准/已咨询是**本轮语义**，刻意只放内存，重启即清。
 */

import fsp from 'node:fs/promises'
import { dirname } from 'node:path'
import { normalizeMode } from './modes.js'

const SCHEMA = 1
const LOCK_WAIT_MS = 2000
const LOCK_STALE_MS = 30_000
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const emptyState = () => ({ schema: SCHEMA, modes: {}, pending: {}, preheat: {} })

/**
 * @param {{path: string, logger?: any, now?: () => number}} options
 */
export function createStore({ path, logger, now = Date.now }) {
  const file = path
  const lockFile = `${file}.lock`
  let state = emptyState()
  let readyPromise

  const warn = (message) => logger?.warn?.(`dsh-commander: ${message}`)

  async function withLock(work) {
    const deadline = now() + LOCK_WAIT_MS
    for (;;) {
      try {
        const handle = await fsp.open(lockFile, 'wx')
        try {
          await handle.writeFile(String(now()))
          return await work()
        } finally {
          await handle.close()
          await fsp.unlink(lockFile).catch(() => {})
        }
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        // 陈旧锁（上个进程崩了）：超过 stale 就抢过来。
        const stat = await fsp.stat(lockFile).catch(() => undefined)
        if (stat !== undefined && now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fsp.unlink(lockFile).catch(() => {})
          continue
        }
        if (now() > deadline) throw new Error('状态文件锁等待超时')
        await sleep(40)
      }
    }
  }

  async function readDisk() {
    const raw = await fsp.readFile(file, 'utf8').catch((error) => {
      if (error?.code !== 'ENOENT') warn(`状态文件读取失败：${error.message}`)
      return undefined
    })
    if (raw === undefined) return emptyState()
    try {
      const parsed = JSON.parse(raw)
      return {
        schema: SCHEMA,
        modes: parsed?.modes && typeof parsed.modes === 'object' ? parsed.modes : {},
        pending: parsed?.pending && typeof parsed.pending === 'object' ? parsed.pending : {},
        preheat: parsed?.preheat && typeof parsed.preheat === 'object' ? parsed.preheat : {},
      }
    } catch {
      // 损坏不抛：备份后从空状态继续，绝不因为一个 JSON 把插件拖死。
      await fsp.rename(file, `${file}.broken-${now()}`).catch(() => {})
      warn('状态文件损坏，已备份并从空状态继续')
      return emptyState()
    }
  }

  async function writeDisk() {
    await fsp.mkdir(dirname(file), { recursive: true })
    await withLock(async () => {
      const tmp = `${file}.${process.pid}.tmp`
      await fsp.writeFile(tmp, JSON.stringify(state), 'utf8')
      await fsp.rename(tmp, file)
    })
  }

  /** 落盘失败只记日志：挡位已经在内存里生效，不该因为磁盘问题挡住交互。 */
  const persist = () => {
    writeDisk().catch((error) => warn(`状态保存失败：${error.message}`))
  }

  const ready = () => {
    if (readyPromise === undefined) {
      readyPromise = readDisk().then((loaded) => {
        state = loaded
      })
    }
    return readyPromise
  }

  return {
    ready,
    /** 同步：只给 tools.guard 用。调用前必须 await ready()（apply 里已做）。 */
    modeRecord: (rootId) => state.modes[rootId],
    mode: (rootId) => normalizeMode(state.modes[rootId]?.mode),
    setMode(rootId, mode, source = 'user') {
      const normalized = normalizeMode(mode)
      if (rootId === undefined || normalized === undefined) return false
      state.modes[rootId] = { mode: normalized, source, at: now() }
      persist()
      return true
    },
    clearMode(rootId) {
      delete state.modes[rootId]
      persist()
    },
    pending: (rootId) => state.pending[rootId],
    setPending(rootId, record) {
      state.pending[rootId] = record
      persist()
    },
    deletePending(rootId) {
      if (state.pending[rootId] === undefined) return false
      delete state.pending[rootId]
      persist()
      return true
    },
    /**
     * 预热的**实测代价**。写下来的原因：这份数据只存在于指挥员会话的事件里，
     * 进程一重启就读不到了，而"让用户知道代价"是明写的承诺。
     */
    preheat: (rootId) => state.preheat[rootId],
    setPreheat(rootId, record) {
      if (rootId === undefined || record === undefined) return false
      state.preheat[rootId] = record
      persist()
      return true
    },
    /** 只读快照（status 用）。 */
    snapshot: () => ({
      modes: Object.keys(state.modes).length,
      pending: Object.keys(state.pending).length,
    }),
  }
}
