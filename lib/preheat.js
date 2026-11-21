/**
 * 预热的「进度 + 代价」（只读）。
 *
 * 为什么必须有：关掉宿主那条完成通知之后，指挥员预热完成在主会话里**不留任何痕迹**。
 * 用户实测的结论就是"新会话根本不会创建指挥员"——而日志显示它 5 秒内就建好并跑完了。
 * 功能是对的，可见性是零。所以这里从指挥员**自己的会话日志**算出代价，交给图标显示。
 *
 * 只读：不投递消息、不进收件箱、不唤醒任何 agent。
 */

import { snapshotEvents } from './session.js'

const timeOf = (event) => (typeof event?.time === 'number' ? event.time : undefined)

/**
 * 逐条累加 token。宿主形状：inputTokens（新输入）/ outputTokens / cacheReadTokens
 * （命中前缀缓存，便宜但不为零）。三者分开报，不把缓存命中说成"花掉"。
 */
export function sumTokens(events) {
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
 * 把指挥员的会话事件总结成「预热代价」。预热＝它的**第一轮**：创建 → 首个 turn/end。
 *
 * 终点必须取首个 turn/end，不能取最后一条事件：否则重启后读旧会话时，
 * 后续日常轮次会被算进"预热时长"，显示成几百小时的假数字。
 *
 * @param {{createdAt?: number, events?: any[]}} input
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
  const created = Number.isFinite(input.createdAt) ? Number(input.createdAt) : first
  const startedAt = Number.isFinite(created) ? created : first
  const finishedAt = end !== undefined && typeof end.time === 'number'
    ? end.time
    : Number.isFinite(last) ? last : startedAt
  const reason = end?.data?.reason?.kind
  return {
    state: end === undefined ? 'running' : reason === 'completed' ? 'done' : 'failed',
    ms: Number.isFinite(startedAt) ? Math.max(0, Math.round(finishedAt - startedAt)) : 0,
    steps,
    tools,
    tokens: sumTokens(events),
  }
}

/**
 * 读数器：跑完即缓存；拿不到会话就返回 undefined ——
 * **宁可什么都不显示，也不编一个数字。**
 *
 * @param {{ctx: any, findCommander: (rootId: string) => Promise<any>, rootIdOf: (agent: any) => string, name: string}} deps
 */
export function createPreheatReader({ ctx, findCommander, rootIdOf, name }) {
  const settled = new Map()

  return async function read(agent) {
    if (agent === undefined || agent === null) return undefined
    let member
    try {
      member = await findCommander(rootIdOf(agent))
    } catch {
      return undefined
    }
    if (member === undefined || typeof member.id !== 'string') return undefined
    const cached = settled.get(member.id)
    if (cached !== undefined) return cached
    try {
      const session = ctx.get('sessions')?.get?.(member.id)
      if (session === undefined || session === null) return undefined
      const events = snapshotEvents(session, 0)
      const summary = summarizePreheat({ createdAt: session.header?.createdAt, events })
      if (summary !== undefined && summary.state !== 'running') settled.set(member.id, summary)
      return summary
    } catch {
      return undefined
    }
  }
}
