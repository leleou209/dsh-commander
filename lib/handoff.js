/**
 * 全接管的交接判定与文案（纯函数）。
 *
 * 用户定的口径：
 *   - 轮次不限，只由指挥员声明「允许结束」来结束；
 *   - 中断就是中断，**不调整接管挡位**——用户随时可以插话或单独停掉某一方；
 *   - 退出全接管立即叫停：在途等待到达的回复不得再唤醒主agent。
 */

import { classifyReply } from './protocol.js'

/** 注入回主agent 的消息 source：语义是「另一个 agent 转来的话」，不触发"用户发言"判定。 */
export const HANDOFF_SOURCE = { kind: 'agent-message', form: 'relay' }

/**
 * 交接前的判定；返回 true 才驱动。每一条都对应一个真实踩过的坑。
 */
export function shouldHandoff(input = {}) {
  if (input.stopping === true) return false
  if (input.inFlight === true) return false
  if (input.isLead !== true) return false
  if (input.mode !== 'full') return false
  if (input.status !== 'idle') return false
  // 只在「真的结束了一轮」之后交接：宿主的 idle 也包含 maintenance（压缩等），
  // 那时候交接会把指令插进正在整理的会话里。
  if (input.turnEnded !== true) return false
  // 已停运（指挥员挂死/超时）就不再驱动，等用户重新设定挡位。
  if (input.stopped === true) return false
  // 用户刚插过话：这一轮不交接，方向盘交还给用户。
  if (input.interrupted === true) return false
  // 并行子agent 还在跑：等它们收口，否则指挥员只能看到半成品。
  if (input.subtreeBusy === true) return false
  return true
}

/**
 * 等回复之后该怎么办。
 *   dead/timeout → 停运，并且**必须清 pending**（否则留脏记录）；
 *   等待期间用户插话 → 让位一次，同样清 pending，不再注入；
 *   正常回复 → 注入指令，pending 由 wait 自己清过。
 */
export function afterWait(input = {}) {
  if (input.stopping === true) return { action: 'stop', clearPending: false, stopped: false }
  if (input.interrupted === true) return { action: 'let-go', clearPending: true, stopped: false }
  if (input.kind === 'dead' || input.kind === 'timeout') return { action: 'stop', clearPending: true, stopped: true }
  if (input.kind === 'reply') return { action: 'wake', clearPending: false, stopped: false }
  return { action: 'stop', clearPending: true, stopped: false }
}

/**
 * 真正唤醒主agent之前再确认一次「现在还该唤醒吗」。
 *
 * driveHandoff 是在 turn/end 那一刻按当时挡位决定交接的，然后可能等很久。
 * 这期间用户完全可能把挡位切走——那条迟到的回复就不再是交接指令，
 * 而是一次凭空的自动唤醒。挡位以**当前**为准，不看决定交接那一刻的快照。
 */
export function shouldWakeParent(input = {}) {
  return input.mode === 'full' && input.stopped !== true
}

/** 指挥员是否已不可用。 */
export function commanderDead(member) {
  if (member === undefined || member === null) return true
  return member.status === 'failed'
}

/** 交给指挥员的那段话：本轮输出 + 当前目标 + 工具摘要。 */
export function renderReport(input = {}) {
  const lines = ['[本轮汇报]']
  const task = String(input.task ?? '').trim()
  if (task.length > 0) lines.push(`当前目标：${task}`)
  const report = String(input.report ?? '').trim()
  lines.push(report.length > 0 ? report : '（本轮没有可见文本输出）')
  const tools = Array.isArray(input.tools) ? input.tools : []
  if (tools.length > 0) {
    const shown = tools.slice(0, 16)
    lines.push('', '本轮工具：', ...shown)
    if (tools.length > shown.length) lines.push(`…还有 ${tools.length - shown.length} 条`)
  }
  lines.push('', '请按契约回复：决定：继续 / 需澄清 / 允许结束。')
  return lines.join('\n')
}

/** 注入回主agent 的那段话。 */
export function renderInstruction(text) {
  return [
    '[指挥员指令]',
    String(text ?? '').trim(),
    '',
    '按上述指令继续执行；完成后本轮结束会自动再交回指挥员。',
    '若用户在对话里给了新指令，以用户最新指令为准。',
  ].join('\n')
}

export { classifyReply }
