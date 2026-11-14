/**
 * 初始化流程（2.9.57）：把「没有指挥员 → 点问号 → 建立并绑定 → 预热 → 就绪」做成可测的纯逻辑。
 *
 * 用户口径（2.9.57 修订）：
 *   1. 初始化只做三件事：**建立并绑定**本会话的指挥员、让它**预热**（自己读四大件粗通项目）、
 *      落到默认挡位 observe 后**停住**；
 *   2. 初始化**不使用输入框草稿**、不产生任何连续行为（不建 goal、不发契约、不往主会话投递）；
 *      模式与任务都由用户随后自己决定；
 *   3. 此后点图标切挡位才是「用户主动改变运行方式」的正常入口。
 *
 * 这一层只做判定，不碰宿主服务，便于穷举测试。
 */

/** 图标要用到的三态。 */
export const ICON_PHASES = ['none', 'provisioning', 'ready']

/** 初始化完成后进入的默认挡位（用户口径：督察模式；随后由用户自己调节）。 */
export const INIT_DEFAULT_STATE = 'observe'

export const PHASE_TIMEOUT_MS = 90_000

/**
 * 初始化相位表（2.9.54）。用户口径：只要指挥 agent 完成与主会话的绑定，初始化就算完成。
 *
 * 关键约束：**禁止从 agent.status 反推相位** —— 之前把 running 当成 provisioning，
 * 结果绑定早就成功、goal 都接管了，图标还在转圈，且永远不会停。
 *
 * 转移只有三条路：markStart（点问号）→ markReady（绑定成功）→ 超时/失败 → failed。
 */
export function createPhaseTracker({ now = () => Date.now(), timeoutMs = PHASE_TIMEOUT_MS } = {}) {
  const table = new Map()
  const read = (id) => {
    const entry = table.get(id)
    if (entry === undefined) return undefined
    if (entry.phase === 'provisioning' && now() - entry.startedAt > timeoutMs) {
      const seconds = Math.round(timeoutMs / 1000)
      const reason = `初始化超过 ${seconds} 秒未完成`
      const failed = { phase: 'failed', startedAt: entry.startedAt, readyAt: undefined, lastError: reason }
      table.set(id, failed)
      return failed
    }
    return entry
  }
  return {
    markStart(id) {
      table.set(id, { phase: 'provisioning', startedAt: now(), readyAt: undefined, lastError: undefined })
    },
    markReady(id) {
      const current = table.get(id)
      table.set(id, { phase: 'ready', startedAt: current?.startedAt, readyAt: now(), lastError: undefined })
    },
    markFailed(id, message) {
      const current = table.get(id)
      table.set(id, { phase: 'failed', startedAt: current?.startedAt, readyAt: undefined, lastError: String(message ?? '初始化失败') })
    },
    clear(id) {
      table.delete(id)
    },
    read,
    /** 对外相位：有记录以记录为准；没记录时按「有没有指挥员」兜底（老会话）。 */
    phaseOf({ sessionId, hasCommander }) {
      const entry = read(sessionId)
      if (entry !== undefined) return entry.phase
      return hasCommander === true ? 'ready' : 'none'
    },
  }
}

/**
 * 「启动 + 落相位」（2.9.55）：绑定成功即 ready，启动抛错先 markFailed 再往上抛。
 *
 * 为什么单独成函数：`index.js:apply` 是 style 棘轮基线（2475 行，零余量），
 * 路由里只留一行调用；失败落账这件事必须可单测，所以留在 lib。
 *
 * @param {{start: () => Promise<any>, tracker: {markReady: Function, markFailed: Function}, id: string}} input
 */
export async function startWithPhase(input = {}) {
  const { start, tracker, id } = input
  try {
    await start()
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    if (typeof tracker?.markFailed === 'function') tracker.markFailed(id, message)
    throw error
  }
  if (typeof tracker?.markReady === 'function') tracker.markReady(id)
  return true
}

/** 子agent 也允许调用的只读 action（其余写操作只给主会话）。 */
export const READ_ONLY_ACTIONS = ['status', 'list', 'team', 'help', 'doctor', 'checks']

// 2.9.58：这里原来的 canControl(agent) 已删。子会话判定改由两处直接读会话头：
// 客户端 lib/client.js 的 sessionIsChild（用宿主槽位的 useSession/useSessions，首帧即判）
// 与 index.js 的 /commander/takeover 路由（agents.get 落空时回退 sessions.get(id).header）。
// 留一个没人用的导出只会长成第二个定义。

/**
 * 初始化请求是否成立：只有「还没有指挥员」时才允许初始化。
 * 已经就绪时再点问号是无意义的（图标也不该显示问号）。
 * @param {{phase: string}} input
 */
export function planInit(input = {}) {
  const phase = input.phase
  if (phase === 'ready') return { allowed: false, reason: 'already-ready' }
  if (phase === 'provisioning') return { allowed: false, reason: 'in-flight' }
  return { allowed: true, state: INIT_DEFAULT_STATE }
}

/**
 * 初始化编排（2.9.57）：建指挥员 → 设默认挡位 → 结束。**不投递任何消息、不碰 goal。**
 * @param {{phase: string, hasCommander?: boolean,
 *   start: () => Promise<any>, setState: (state: string) => Promise<any>}} input
 */
export async function runInitFlow(input = {}) {
  const plan = planInit({ phase: input.phase })
  if (!plan.allowed) return { started: false, reason: plan.reason }
  const result = { started: false, state: plan.state }
  if (input.hasCommander !== true) {
    try {
      await input.start()
      result.started = true
    } catch (error) {
      return { ...result, reason: 'start-failed', message: error && error.message ? error.message : String(error) }
    }
  }
  try {
    await input.setState(plan.state)
  } catch (error) {
    result.stateError = error && error.message ? error.message : String(error)
  }
  return result
}
