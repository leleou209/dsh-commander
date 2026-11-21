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

const emptyState = () => ({ schema: SCHEMA, modes: {}, pending: {}, preheat: {}, forgotten: {}, routes: {} })

/** 进程还活着吗：ESRCH=已退出；EPERM=活着（只是不归我们管），按活着算。 */
const alive = (pid) => {
  if (pid === process.pid) return true
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** 超过这个时长还没回音的 pending 一律当陈旧：正常咨询是秒级/分钟级，不该跨半天。 */
const STALE_PENDING_MS = 12 * 60 * 60 * 1000

/**
 * 丢掉「发起它的进程已经不在」的 pending。
 *
 * 不清理的后果是只增不减：每重启一次、每个发过咨询的会话都会留下一条，
 * 状态文件里长出一堆死请求（实测 10 条，PID 全已退出），诊断时全是噪声。
 * 同一个进程（哪怕重开窗口）发起的请求保留，等待逻辑不受影响。
 *
 * 注意 PID 会被复用：一个死请求的 PID 可能正好被别的进程占用，「活着」不足以
 * 证明它是原主。所以再加一道时间闸——本进程的条目永远保留，别人的超过
 * STALE_PENDING_MS 就丢。
 */
const prunePending = (pending, at = Date.now()) => {
  const next = {}
  for (const [rootId, record] of Object.entries(pending ?? {})) {
    if (record === null || typeof record !== 'object') continue
    if (record.processId === process.pid) {
      next[rootId] = record
      continue
    }
    if (!alive(record.processId)) continue
    if (Number.isFinite(record.sentAt) && at - record.sentAt > STALE_PENDING_MS) continue
    next[rootId] = record
  }
  return next
}

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
        pending: parsed?.pending && typeof parsed.pending === 'object' ? prunePending(parsed.pending) : {},
        preheat: parsed?.preheat && typeof parsed.preheat === 'object' ? parsed.preheat : {},
        forgotten: parsed?.forgotten && typeof parsed.forgotten === 'object' ? parsed.forgotten : {},
        routes: parsed?.routes && typeof parsed.routes === 'object' ? parsed.routes : {},
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
    /**
     * 本会话"已遗忘"的指挥员 id 集合。
     *
     * 为什么需要它：宿主的 `subagentCatalog` 是父会话日志里的持久投影，
     * 归档或删掉子会话都**不会**让那个条目消失（最多少数情况下退化成 diagnostic）。
     * 而销毁句柄只在"本次进程内创建"时拿得到，重启后认领来的没有句柄。
     * 所以要让某个指挥员从此不被认领，只能在插件这一层记住它的 id。
     */
    forgotten(rootId) {
      const list = state.forgotten[rootId]
      return new Set(Array.isArray(list) ? list : [])
    },
    addForgotten(rootId, id) {
      if (rootId === undefined || typeof id !== 'string' || id.length === 0) return false
      const list = Array.isArray(state.forgotten[rootId]) ? state.forgotten[rootId] : []
      if (!list.includes(id)) list.push(id)
      state.forgotten[rootId] = list
      persist()
      return true
    },
    clearForgotten(rootId) {
      delete state.forgotten[rootId]
      persist()
    },
    /**
     * 本会话给指挥员指定的 LLM 路由（`commander(action="recreate")` 写入）。
     * 宿主 UI 不让 addressed 子会话切模型，所以"换强模型"只能落在这里、
     * 下次建立时用它。
     */
    route: (rootId) => state.routes[rootId],
    setRoute(rootId, route) {
      if (rootId === undefined) return false
      const next = {}
      for (const key of ['provider', 'model', 'reasoningEffort']) {
        const value = typeof route?.[key] === 'string' ? route[key].trim() : ''
        if (value.length > 0) next[key] = value
      }
      if (Object.keys(next).length === 0) delete state.routes[rootId]
      else state.routes[rootId] = next
      persist()
      return true
    },
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
