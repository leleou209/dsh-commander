/**
 * 全接管的自动交接驱动（2.9.38 P1 从 index.js 搬出）。
 *
 * 逻辑逐行未改。差异只有一处：所有外部依赖（宿主服务、持久化、文案、判定函数）
 * 由工厂注入，不再直接读 apply() 闭包 —— 这也是把这段最容易出回归的代码
 * 单独隔离出来的意义：依赖表就是它的耦合清单。
 *
 * 依赖方向：只 import `handoff.js` 的纯函数；不反向 import index.js。
 */

import { afterWait, classifyReply, HANDOFF_SOURCE, renderInstruction, renderReport, shouldHandoff, shouldWakeParent } from './handoff.js'

/**
 * @param {{
 *   ctx: any,
 *   t: (key: string, params?: any) => string,
 *   waitMs: number,
 *   pollMs: number,
 *   waitCommander: (agent: any, requestId?: string) => Promise<any>,
 *   commanderMember: (agent: any) => any,
 *   commanderDead: (member: any) => boolean,
 *   currentTakeover: (agent: any) => { state: string },
 *   commanderIds: Set<string>,
 *   sendToCommander: (agent: any, target: any, message: string, signal: AbortSignal, cwd: string) => Promise<any>,
 *   resolveCwd: (ctx: any, agent: any, signal: AbortSignal) => Promise<string>,
 *   currentGoalObjective: (agent: any) => string | undefined,
 *   clearPending: (leadId: string) => Promise<any>,
 *   loadPending: (leadId: string) => Promise<any>,
 *   rootSessionIdOf: (agent: any) => string,
 * }} deps
 */
/**
 * 并列子agent 是否还在跑（指挥员自己不算）：full 接管下交接要等它们收口（2.9.46）。
 * 读不到 subagents/agents 服务时一律当作「不忙」，绝不因为探测失败卡住交接。
 * @returns {Promise<boolean>}
 */
export async function subtreeBusyOf(agent, { ctx, commanderIds, rootSessionIdOf }) {
  const sub = ctx.get('subagents')
  if (sub === undefined || typeof sub.listDescendants !== 'function') return false
  try {
    const entries = await sub.listDescendants(rootSessionIdOf(agent), new AbortController().signal)
    return (Array.isArray(entries) ? entries : []).some((entry) => {
      if (entry?.kind !== 'child' || commanderIds.has(entry.id)) return false
      const status = ctx.get('agents')?.get?.(entry.id)?.status
      return status === 'running' || status === 'provisioning'
    })
  } catch {
    return false
  }
}
export function createHandoffDriver(deps) {
  const {
    ctx,
    t,
    waitMs: HANDOFF_WAIT_MS,
    pollMs: HANDOFF_POLL_MS,
    waitCommander,
    commanderMember,
    commanderDead,
    currentTakeover,
    commanderIds,
    sendToCommander,
    resolveCwd,
    currentGoalObjective,
    clearPending,
    loadPending,
    rootSessionIdOf,
  } = deps

  /**
   * 等指挥员回复，但带看门狗：它挂死/超时就停运，不无限挂着。
   * @returns {{kind: string, text?: string}} waitCommander 的原结果，或 {kind:'dead'|'timeout'}
   */
  async function waitCommanderGuarded(agent, requestId) {
    let settled = false
    const startedAt = Date.now()
    const watchdog = (async () => {
      while (!settled) {
        await new Promise((done) => {
          const timer = setTimeout(done, HANDOFF_POLL_MS)
          timer.unref?.()
        })
        if (settled) return undefined
        if (commanderDead(commanderMember(agent))) return { kind: 'dead' }
        if (Date.now() - startedAt > HANDOFF_WAIT_MS) return { kind: 'timeout' }
      }
      return undefined
    })()
    try {
      return await Promise.race([waitCommander(agent, requestId), watchdog])
    } finally {
      settled = true
    }
  }

  /** 把指挥员的指令注入回主agent，并唤醒它开新一轮。 */
  function wakeWithInstruction(agent, text, commanderId) {
    const base = {
      role: 'user',
      id: `commander-handoff-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      content: [{ type: 'text', text: renderInstruction(text, t) }],
    }
    try {
      agent.followup({ ...base, source: { ...HANDOFF_SOURCE, senderSessionId: commanderId } })
      return true
    } catch (error) {
      // senderSessionId 缺失/不合法时退回 runtime-context：语义弱一点，但能送达。
      try {
        agent.followup({ ...base, source: { kind: 'runtime-context' } })
        return true
      } catch (fallbackError) {
        ctx.logger?.warn?.(
          `dsh-commander: 自动交接唤醒失败：${fallbackError && fallbackError.message ? fallbackError.message : fallbackError}`,
        )
        return false
      }
    }
  }

  /**
   * 本轮工具摘要：把 `tool/call` 与 `tool/result` 配成一行一条。
   *
   * 只给指挥员看「干了什么、成没成」，参数截断到 60 字——它要判断方向，
   * 不需要重读全部输出。
   */
  function summarizeTools(session, fromSeq) {
    let events = []
    try {
      events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents(fromSeq) : []
    } catch {
      events = []
    }
    const calls = new Map()
    const rows = []
    for (const event of events) {
      if (event?.type === 'tool/call') {
        const callId = event.data?.callId
        const name = String(event.data?.name ?? 'tool')
        const args = String(event.data?.arguments ?? '')
        const row = { name, args, failed: undefined }
        if (callId !== undefined) calls.set(callId, row)
        rows.push(row)
        continue
      }
      if (event?.type === 'tool/result') {
        const row = calls.get(event.data?.callId)
        if (row !== undefined) row.failed = Boolean(event.error) || event.data?.message?.isError === true
      }
    }
    return rows
      .filter((row) => row.failed !== undefined || row.args.length > 0)
      .map((row) => {
        const compact = row.args.replace(/\s+/g, ' ').trim()
        const shown = compact.length > 60 ? `${compact.slice(0, 60)}…` : compact
        const mark = row.failed === undefined ? '…' : row.failed ? '✗' : '✓'
        return `${mark} ${row.name}${shown.length > 0 ? `: ${shown}` : ''}`
      })
  }

  function lastTurnStartSeq(session) {
    let seq = 0
    try {
      const events = session?.ownEvents?.() ?? []
      // 从后往前找：长会话每轮都全量扫描是浪费。
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]
        if (event?.type === 'turn/start' && typeof event.seq === 'number') {
          seq = event.seq
          break
        }
      }
    } catch {
      seq = 0
    }
    return seq
  }

  async function driveHandoff(state) {
    const agent = state.agent
    const header = agent?.session?.header
    const isLead = Boolean(header) && !header.parentSession && !commanderIds.has(agent.id)
    const takeoverState = currentTakeover(agent).state
    const busy = await subtreeBusyOf(agent, { ctx, commanderIds, rootSessionIdOf })
    const ready = shouldHandoff({
      stopping: state.stopping,
      inFlight: state.inFlight,
      isLead,
      takeover: takeoverState,
      status: agent.status,
      turnEnded: state.turnEnded,
      stopped: state.stopped,
      interrupted: state.interrupted,
      subtreeBusy: busy,
    })
    if (!ready) {
      // 记下到底哪一条没过——排查不靠猜。
      state.lastSkip = `stopping=${state.stopping} inFlight=${state.inFlight} isLead=${isLead} takeover=${takeoverState} status=${agent.status} turnEnded=${state.turnEnded} stopped=${state.stopped} interrupted=${state.interrupted} subtreeBusy=${busy}`
      // 只是「等并行子agent」没过：1.5s 再看一次，避免没有新事件就永远不交接。
      if (busy && !state.stopping) setTimeout(() => requestHandoffDrive(state), 1500).unref?.()
      if (state.interrupted) state.interrupted = false
      return
    }
    // 一次 turn/end 只交接一次。
    state.turnEnded = false
    const session = agent.session
    // 只看本轮：lastSeq 在插件重载后是 0，不限窗口会把整个会话的工具都摘要一遍。
    const fromSeq = Math.max(state.lastSeq, lastTurnStartSeq(session))
    const report = lastAssistantText(session, fromSeq, state.lastAt)
    const tools = summarizeTools(session, fromSeq)
    state.lastSeq = session?.seq ?? 0
    state.lastAt = Date.now()
    if (report.trim().length === 0 && tools.length === 0) {
      state.lastSkip = '本轮没有可见输出也没有工具调用'
      return
    }
    state.inFlight = true
    try {
      // team 服务校验 AbortSignal：传 undefined 会抛 signals[0] is not of type AbortSignal，这里自带一个。
      const signal = new AbortController().signal
      const cwd = await resolveCwd(ctx, agent, signal).catch(() => process.cwd())
      const task = currentGoalObjective(agent)
      const sent = await sendToCommander(agent, undefined, renderReport({ report, task, tools, t }), signal, cwd)
      const result = await waitCommanderGuarded(agent, sent?.requestId)
      const outcome = afterWait({ kind: result?.kind, interrupted: state.interrupted, stopping: state.stopping })
      // 该清的 pending 一定要清：dead/timeout/让位都会留下脏记录。
      if (outcome.clearPending) await clearPending(rootSessionIdOf(agent)).catch(() => {})
      if (outcome.stopped) state.stopped = true
      if (outcome.action === 'stop') {
        state.interrupted = false
        ctx.logger?.warn?.(`dsh-commander: 自动交接停止（${result?.kind ?? 'unknown'}）`)
        return
      }
      if (outcome.action === 'let-go') {
        state.interrupted = false
        ctx.logger?.info?.('dsh-commander: 等回复期间用户插话，本次交接让位')
        return
      }
      const verdict = classifyReply(result.text)
      if (verdict === 'finish') {
        ctx.logger?.info?.('dsh-commander: 自动交接收到「允许结束」，停止驱动')
        return
      }
      if (!shouldWakeParent({ takeover: currentTakeover(agent).state, stopped: state.stopped })) return
      const pending = await loadPending(rootSessionIdOf(agent)).catch(() => undefined)
      wakeWithInstruction(agent, result.text, pending?.commanderId ?? '')
    } catch (error) {
      state.lastError = `drive: ${error && error.message ? error.message : error}`
      ctx.logger?.warn?.(`dsh-commander: 自动交接失败：${state.lastError}`)
    } finally {
      state.inFlight = false
      state.lastDriveAt = Date.now()
    }
  }
  /** 同一个 agent 的驱动串行化（照 goal-round-driver 的骨架）。 */
  function requestHandoffDrive(state) {
    if (state.stopping) return
    state.requested = true
    if (state.run !== undefined) return
    let run
    try {
      // withoutInitiator 只是归因卫生：拿不到就直连，别为它把整条交接断掉（agents 未 inject，只能 ctx.get）。
      let agentsService
      try {
        agentsService = ctx.get('agents')
      } catch {
        agentsService = undefined
      }
      const body = async () => {
        while (state.requested && !state.stopping) {
          state.requested = false
          try {
            await driveHandoff(state)
          } catch (error) {
            state.lastError = error && error.message ? error.message : String(error)
            ctx.logger?.warn?.(`dsh-commander: 交接驱动异常：${state.lastError}`)
          }
        }
      }
      run =
        typeof agentsService?.withoutInitiator === 'function'
          ? agentsService.withoutInitiator(body)
          : body()
    } catch (error) {
      state.lastError = `drive start: ${error && error.message ? error.message : error}`
      state.requested = false
      return
    }
    state.run = run
    const retire = () => {
      state.run = undefined
      if (state.requested && !state.stopping) requestHandoffDrive(state)
    }
    run.then(retire, retire)
  }

  function assistantTextOfContent(content) {
    if (!Array.isArray(content)) return ''
    return content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
  }

  function lastAssistantText(session, fromSeq, sinceTime = 0) {
    let events = []
    try {
      events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents(fromSeq) : session?.events ?? []
    } catch {
      events = session?.events ?? []
    }
    let text = ''
    for (const event of events) {
      if (event?.type !== 'assistant/message') continue
      if (typeof event.time === 'number' && event.time < sinceTime) continue
      const candidate = assistantTextOfContent(event.data?.message?.content)
      if (candidate.length > 0) text = candidate
    }
    return text
  }
  return {
    driveHandoff,
    requestHandoffDrive,
    waitCommanderGuarded,
    wakeWithInstruction,
    summarizeTools,
    lastTurnStartSeq,
    lastAssistantText,
    assistantTextOfContent,
  }
}