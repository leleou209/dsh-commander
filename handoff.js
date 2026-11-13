/**
 * 全接管的自动交接（handoff）：主agent 每轮停下就把输出交回指挥员，
 * 钩子等指挥员的指令，再把它作为新一轮的输入唤醒主agent。
 *
 * 这里是纯逻辑（便于单测），不依赖宿主：
 *   - shouldHandoff   什么时候该交接
 *   - classifyReply   指挥员的回复算「继续 / 需澄清 / 允许结束」
 *   - renderReport    交给指挥员的那段话
 *   - renderInstruction 注入回主agent 的那段话
 *
 * 设计口径（用户定的）：
 *   - 轮次不限，只由指挥员声明任务完成来结束；
 *   - 中断就是中断，不调整接管状态——用户随时可以插话或单独停掉某一方。
 */

/** 注入回主agent 的消息用的 source：语义就是"另一个 agent 转来的话"。 */
export const HANDOFF_SOURCE = { kind: 'agent-message', form: 'relay' }

/** 交接前的判定；返回 true 才驱动。 */
export function shouldHandoff(input = {}) {
  if (input.stopping === true) return false
  if (input.inFlight === true) return false
  if (input.isLead !== true) return false
  if (input.takeover !== 'full') return false
  if (input.status !== 'idle') return false
  // 用户刚插过话：这一轮不交接，把方向盘交还给用户。
  if (input.interrupted === true) return false
  return true
}

/**
 * 指挥员的回复分类。
 * @returns {'finish'|'clarify'|'continue'} finish=允许结束、clarify=需澄清、其余按继续
 */
export function classifyReply(text) {
  const value = String(text ?? '')
  if (value.includes('允许结束')) return 'finish'
  if (value.includes('需澄清')) return 'clarify'
  return 'continue'
}

/** 交给指挥员的那段话：本轮输出 + 轮次 + 代码状态。 */
export function renderReport(input = {}) {
  const round = Number.isFinite(input.round) ? input.round : 0
  const report = String(input.report ?? '').trim()
  const codeState = input.codeState ? String(input.codeState) : ''
  const lines = [
    `[自动交接 #${round}] 主agent 已停下，以下是它本轮的最后输出。`,
    '',
    report.length > 0 ? report : '（本轮没有可见输出）',
    '',
    '请给下一步指令：继续 / 需澄清 / 允许结束。',
  ]
  if (codeState.length > 0) lines.push('', `代码状态：${codeState}`)
  return lines.join('\n')
}

/** 注入回主agent 的那段话：指挥员的原始指令 + 一句边界说明。 */
export function renderInstruction(reply) {
  const text = String(reply ?? '').trim()
  return [
    '[指挥员指令] 以下是指挥员对上一轮的回复，按它继续：',
    '',
    text.length > 0 ? text : '（指挥员回复为空）',
    '',
    '注意：这是全接管下的自动交接，不要停下来问用户；拿不准就再汇报一轮。',
  ].join('\n')
}
