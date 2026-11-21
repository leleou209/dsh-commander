/**
 * 全接管的自动交接驱动。
 *
 * 这是全项目唯一「天生难」的部分，每一条守卫都对应一个真实踩过的坑：
 *   - 触发点是 turn/end，不是轮询 status（宿主 idle 也含 maintenance）；
 *   - 每个 agent 一个串行驱动，run/requested 合并触发，不会并发交接；
 *   - inFlight 防重入；lastSeq/lastAt 基线防止重复发送同一段输出；
 *   - 看门狗：指挥员挂死/超时就停运，不无限挂着；
 *   - 用户插话 → 让位一次；dispose/卸载 → stopping；
 *   - 并行子agent 未收口 → 等；
 *   - **唤醒前重读挡位**：退出全接管后，在途回复不得再点燃主agent。
 *
 * 会话读取helper 放在模块级（不进工厂），工厂只留编排。
 */

import { afterWait, classifyReply, commanderDead, HANDOFF_SOURCE, renderInstruction, renderReport, shouldHandoff, shouldWakeParent } from './handoff.js'
import { snapshotEvents } from './session.js'

const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()

/** 本轮最后一段助手文本（带时间基线，避免重发旧输出）。 */
export function lastAssistantText(session, fromSeq, sinceTime = 0) {
  const events = snapshotEvents(session, fromSeq)
  let text = ''
  for (const event of events) {
    if (event?.type !== 'assistant/message') continue
    if (typeof event.time === 'number' && event.time < sinceTime) continue
    const candidate = textOf(event.data?.message?.content)
    if (candidate.length > 0) text = candidate
  }
  return text
}

/** 本轮工具摘要：tool/call 与 tool/result 配成一行一条，参数截断 60 字。 */
function summarizeTools(session, fromSeq) {
  const events = snapshotEvents(session, fromSeq)
  const calls = new Map()
  const rows = []
  for (const event of events) {
    if (event?.type === 'tool/call') {
      const row = { name: String(event.data?.name ?? 'tool'), args: String(event.data?.arguments ?? ''), failed: undefined }
      if (event.data?.callId !== undefined) calls.set(event.data.callId, row)
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

/** 最近一次 turn/start 的 seq：插件重载后 lastSeq 是 0，不限窗口会把整个会话摘要一遍。 */
function lastTurnStartSeq(session) {
  try {
    const events = session?.ownEvents?.() ?? []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]?.type === 'turn/start' && typeof events[index].seq === 'number') return events[index].seq
    }
  } catch {
    return 0
  }
  return 0
}

/**
 * @param {{
 *   ctx: any, store: any, name: string, waitMs: number, pollMs: number,
 *   rootIdOf: (agent: any) => string,
 *   modeOf: (agent: any) => Promise<string>,
 *   findCommander: (rootId: string) => Promise<any>,
 *   sendToCommander: (agent: any, targetId: string, text: string, signal: AbortSignal) => Promise<any>,
 *   waitReply: (agent: any, requestId?: string) => Promise<any>,
 *   subtreeBusy: (rootId: string) => Promise<boolean>,
 *   resolveCwd: (agent: any, signal: AbortSignal) => Promise<string>,
 *   goalObjective: (agent: any) => string|undefined,
 * }} deps
 */
export function createDriver(deps) {
  const { ctx, store, waitMs, pollMs } = deps
  const states = new Map()

  const stateFor = (agent) => {
    let state = states.get(agent.id)
    if (state === undefined) {
      state = {
        agent, stopping: false, inFlight: false, stopped: false, interrupted: false,
        turnEnded: false, requested: false, run: undefined, lastSeq: 0, lastAt: 0, idleSeen: 0,
        abort: undefined, cancelled: false,
      }
      states.set(agent.id, state)
    }
    return state
  }

  /** 等回复，但带看门狗：挂死/超时就停运。signal 用来「退场即收口」。 */
  async function waitGuarded(agent, requestId, signal) {
    let settled = false
    const startedAt = Date.now()
    const watchdog = (async () => {
      while (!settled) {
        await new Promise((done) => {
          const timer = setTimeout(done, pollMs)
          timer.unref?.()
        })
        if (settled) return undefined
        if (commanderDead(await deps.findCommander(deps.rootIdOf(agent)))) return { kind: 'dead' }
        if (Date.now() - startedAt > waitMs) return { kind: 'timeout' }
      }
      return undefined
    })()
    try {
      return await Promise.race([deps.waitReply(agent, requestId, signal), watchdog])
    } finally {
      settled = true
    }
  }

  /** 把指挥员的指令注入回主agent 并唤醒它开新一轮。 */
  function wake(agent, text, commanderId) {
    const base = {
      role: 'user',
      id: `commander-handoff-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      content: [{ type: 'text', text: renderInstruction(text) }],
    }
    try {
      agent.followup({ ...base, source: { ...HANDOFF_SOURCE, senderSessionId: commanderId } })
      return true
    } catch {
      // senderSessionId 不合法时退回 runtime-context：语义弱一点，但能送达。
      try {
        agent.followup({ ...base, source: { kind: 'runtime-context' } })
        return true
      } catch (error) {
        ctx.logger?.warn?.(`dsh-commander: 交接唤醒失败：${error?.message ?? error}`)
        return false
      }
    }
  }

  async function drive(state) {
    const agent = state.agent
    const header = agent?.session?.header
    const rootId = deps.rootIdOf(agent)
    const isLead = Boolean(header) && !header.parentSession
    const mode = await deps.modeOf(agent)
    const busy = await deps.subtreeBusy(rootId)
    const ready = shouldHandoff({
      stopping: state.stopping, inFlight: state.inFlight, isLead, mode,
      status: agent.status, turnEnded: state.turnEnded, stopped: state.stopped,
      interrupted: state.interrupted, subtreeBusy: busy,
    })
    if (!ready) {
      // 只是「等并行子agent」没过：1.5s 再看一次，避免没有新事件就永远不交接。
      if (busy && !state.stopping) {
        const timer = setTimeout(() => requestDrive(state), 1500)
        timer.unref?.()
      }
      if (state.interrupted) state.interrupted = false
      return
    }
    state.turnEnded = false
    const session = agent.session
    const fromSeq = Math.max(state.lastSeq, lastTurnStartSeq(session))
    const report = lastAssistantText(session, fromSeq, state.lastAt)
    const tools = summarizeTools(session, fromSeq)
    state.lastSeq = session?.seq ?? 0
    state.lastAt = Date.now()
    if (report.trim().length === 0 && tools.length === 0) return
    state.inFlight = true
    // 退场即收口：切走 full 时 abort 这次等待，不等满 waitMs 再自然结束。
    const controller = new AbortController()
    state.abort = controller
    state.cancelled = false
    try {
      const signal = controller.signal
      const member = await deps.findCommander(rootId)
      if (member === undefined) return
      const text = renderReport({ report, task: deps.goalObjective(agent), tools })
      const sent = await deps.sendToCommander(agent, member.id, text, signal)
      const result = await waitGuarded(agent, sent?.requestId, signal)
      const outcome = afterWait({ kind: result?.kind, interrupted: state.interrupted, stopping: state.stopping })
      if (outcome.clearPending) store.deletePending(rootId)
      if (outcome.stopped) state.stopped = true
      if (outcome.action !== 'wake') {
        state.interrupted = false
        return
      }
      if (classifyReply(result.text) === 'finish') return
      // 关键：唤醒前重读当前挡位。等待期间用户可能已经退出全接管。
      if (!shouldWakeParent({ mode: await deps.modeOf(agent), stopped: state.stopped })) return
      wake(agent, result.text, store.pending(rootId)?.commanderId ?? member.id)
    } catch (error) {
      if (state.cancelled) {
        // 用户切走了挡位：立刻收口，清 pending，不唤醒、不刷 warn。
        store.deletePending(rootId)
      } else {
        ctx.logger?.warn?.(`dsh-commander: 交接失败：${error?.message ?? error}`)
      }
    } finally {
      state.abort = undefined
      state.inFlight = false
    }
  }

  /** 同一个 agent 的驱动串行化。 */
  function requestDrive(state) {
    if (state.stopping) return
    state.requested = true
    if (state.run !== undefined) return
    const body = async () => {
      while (state.requested && !state.stopping) {
        state.requested = false
        try {
          await drive(state)
        } catch (error) {
          ctx.logger?.warn?.(`dsh-commander: 交接驱动异常：${error?.message ?? error}`)
        }
      }
    }
    let run
    try {
      const agents = ctx.get('agents')
      run = typeof agents?.withoutInitiator === 'function' ? agents.withoutInitiator(body) : body()
    } catch {
      state.requested = false
      return
    }
    state.run = run
    const retire = () => {
      state.run = undefined
      if (state.requested && !state.stopping) requestDrive(state)
    }
    run.then(retire, retire)
  }

  return {
    stateFor,
    requestDrive,
    /** 挡位切换后清掉停运/让位标志：重新设定就是显式要求重新开始。 */
    reset(agent) {
      const state = states.get(agent.id)
      if (state === undefined) return
      state.stopped = false
      state.interrupted = false
      state.turnEnded = false
    },
    stop(agent) {
      const state = states.get(agent.id)
      if (state === undefined) return
      state.stopping = true
      state.cancelled = true
      state.abort?.abort()
      states.delete(agent.id)
    },
    /**
     * 退场即收口：中断在途等待，不必挂满 waitMs。
     * 只影响当前这次驱动；重新进入 full 后 reset + requestDrive 照常恢复。
     */
    cancelWait(agent) {
      const state = states.get(agent?.id)
      if (state === undefined) return false
      state.cancelled = true
      state.abort?.abort()
      return true
    },
    stopAll() {
      for (const state of states.values()) state.stopping = true
      states.clear()
    },
  }
}
