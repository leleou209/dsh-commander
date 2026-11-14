/**
 * 初始化的「进度 + 代价」（2.9.62）。
 *
 * 为什么需要：2.9.58 之后宿主不再替指挥员播报"我干完了"，主会话一个字都不会多 ——
 * 用户看到的就是"什么都没发生"（实际它已经建好并预热完了）。所以必须有一个**看得见**
 * 的信号，并且要告诉用户**代价**：花了多久、几步、多少 token。
 *
 * 数据全部从指挥员**自己的会话日志**读（创建时刻、步数、工具调用数、token 用量）。
 * 只读：不投递消息、不进收件箱、不唤醒任何 agent。
 */

/** 单个事件的时间；没有 time 的返回 undefined。 */
const timeOf = (event) => (typeof event?.time === 'number' ? event.time : undefined)

/**
 * 从 assistant/message 的 usage 逐条累加 token。
 *
 * 宿主形状：`inputTokens`（真金白银的新输入）/ `outputTokens` / `cacheReadTokens`
 * （命中前缀缓存，便宜但不为零）。三者分开报，避免把"缓存命中"说成"花掉"。
 *
 * @param {any[]} events
 * @returns {{input: number, output: number, cacheRead: number, total: number}} total = 新输入 + 输出
 */
export function sumPreheatTokens(events) {
  let input = 0
  let output = 0
  let cacheRead = 0
  for (const event of events) {
    if (event?.type !== 'assistant/message') continue
    const usage = event.data?.usage ?? event.data?.message?.usage
    if (usage === undefined || usage === null) continue
    input += Number(usage.inputTokens) || 0
    output += Number(usage.outputTokens) || 0
    cacheRead += Number(usage.cacheReadTokens) || 0
  }
  return { input, output, cacheRead, total: input + output }
}
/**
 * 纯函数：把指挥员的会话事件总结成"预热代价"。
 *
 * 预热＝它的**第一轮**：从会话创建到第一次 `turn/end`。
 *
 * @param {{createdAt?: number, events?: any[]}} input
 * @returns {{state: string, ms: number, steps: number, tools: number,
 *   tokens: {input: number, output: number, cacheRead: number, total: number}}} | undefined
 */
export function summarizePreheat(input = {}) {
  const events = Array.isArray(input.events) ? input.events : []
  if (events.length === 0) return undefined
  let first = Number.POSITIVE_INFINITY
  let last = Number.NEGATIVE_INFINITY
  let steps = 0
  let tools = 0
  let end
  for (const event of events) {
    const at = timeOf(event)
    if (at !== undefined) {
      if (at < first) first = at
      if (at > last) last = at
    }
    if (event?.type === 'step/start') steps += 1
    if (event?.type === 'tool/call') tools += 1
    if (event?.type === 'turn/end' && end === undefined) end = event
  }
  const createdAt = Number.isFinite(input.createdAt) ? Number(input.createdAt) : first
  const startedAt = Number.isFinite(createdAt) ? createdAt : first
  // 预热终点＝**第一轮** turn/end；没有它才退回最后一条事件。
  // 否则重启后读旧会话时，后续日常轮次会被算进「预热时长」，显示成几百小时的假数字。
  const finishedAt = end !== undefined && typeof end.time === 'number' ? end.time : Number.isFinite(last) ? last : startedAt
  const reason = end?.data?.reason?.kind
  return {
    state: end === undefined ? 'running' : reason === 'completed' ? 'done' : 'failed',
    ms: Number.isFinite(startedAt) ? Math.max(0, Math.round(finishedAt - startedAt)) : 0,
    steps,
    tools,
    tokens: sumPreheatTokens(events),
  }
}

/**
 * 预热读数器：按指挥员的会话 id 取值，跑完就缓存（不再扫日志）。
 *
 * 拿不到会话（空闲、已释放、重启后未加载）就返回 undefined —— **宁可什么都不显示，
 * 也不要编一个数字**。
 *
 * @param {{ctx: any, membersOf: (agent: any) => any[], commanderName: string}} deps
 */
export function createPreheatTracker({ ctx, membersOf, commanderName }) {
  /** childId -> 定稿的摘要（只有 done/failed 才缓存）。 */
  const settled = new Map()

  const sessionsOf = () => {
    try {
      return ctx.get('sessions')
    } catch {
      return undefined
    }
  }

  /**
   * @param {any} agent 当前会话的活 agent
   * @returns {{state: string, ms: number, steps: number, tools: number,
   *   tokens: {input: number, output: number, cacheRead: number, total: number}}} | undefined
   */
  function read(agent) {
    if (agent === undefined || agent === null) return undefined
    let member
    try {
      const rows = membersOf(agent)
      member = Array.isArray(rows) ? rows.find((row) => row?.name === commanderName) : undefined
    } catch {
      return undefined
    }
    if (member === undefined || typeof member.id !== 'string') return undefined
    const cached = settled.get(member.id)
    if (cached !== undefined) return cached
    try {
      const session = sessionsOf()?.get?.(member.id)
      if (session === undefined || session === null) return undefined
      const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents(0) : []
      const summary = summarizePreheat({ createdAt: session.header?.createdAt, events })
      if (summary !== undefined && summary.state !== 'running') settled.set(member.id, summary)
      return summary
    } catch {
      return undefined
    }
  }

  return { read }
}
