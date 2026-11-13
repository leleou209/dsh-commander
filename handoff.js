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

import { createTranslator } from './messages.js'

/** 注入回主agent 的消息用的 source：语义就是"另一个 agent 转来的话"。 */
export const HANDOFF_SOURCE = { kind: 'agent-message', form: 'relay' }

/** 交接前的判定；返回 true 才驱动。 */
export function shouldHandoff(input = {}) {
  if (input.stopping === true) return false
  if (input.inFlight === true) return false
  if (input.isLead !== true) return false
  if (input.takeover !== 'full') return false
  if (input.status !== 'idle') return false
  // 只在「真的结束了一轮」之后交接：宿主的 idle 也包含 maintenance（压缩等），
  // 那时候交接会把指令插进正在整理的会话里。
  if (input.turnEnded !== true) return false
  // 已经停运（指挥员挂死/超时）就不再驱动，等用户重新设定状态。
  if (input.stopped === true) return false
  // 用户刚插过话：这一轮不交接，把方向盘交还给用户。
  if (input.interrupted === true) return false
  return true
}

/** 指挥员是否已经不可用（挂死/不存在）。 */
export function commanderDead(member) {
  if (member === undefined || member === null) return true
  return member.status === 'failed'
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

/**
 * 交接文案的取词函数。
 *
 * 交接正文是**给模型看的话**，不是界面文案，但它同样要跟随插件语言：用户把
 * locale 切成 en 时，不该继续收到中文提示。这里默认 zh-CN，宿主传自己的 t 进来。
 *
 * 注意：`classifyReply` 里的「允许结束 / 需澄清」是**契约令牌**，不随语言变——
 * 指挥员的回复必须带这两个中文词，换语言等于改协议。
 */
const defaultT = createTranslator('zh-CN')

function pickT(t) {
  return typeof t === 'function' ? t : defaultT
}

/** 交给指挥员的那段话：本轮输出 + 当前任务 + 工具摘要 + 代码状态。 */
export function renderReport(input = {}) {
  const t = pickT(input.t)
  const report = String(input.report ?? '').trim()
  const task = String(input.task ?? '').trim()
  const codeState = input.codeState ? String(input.codeState) : ''
  const tools = Array.isArray(input.tools) ? input.tools.filter((row) => String(row ?? '').trim().length > 0) : []
  const lines = [t('handoff.reportHeader'), '']
  if (task.length > 0) lines.push(t('handoff.task', { task }), '')
  lines.push(report.length > 0 ? report : t('handoff.noOutput'))
  if (tools.length > 0) {
    lines.push('', t('handoff.toolsHeader'))
    for (const row of tools.slice(0, 16)) lines.push(`- ${row}`)
    if (tools.length > 16) lines.push(`- ${t('handoff.toolsMore', { count: tools.length - 16 })}`)
  }
  lines.push('', t('handoff.askNext'))
  if (codeState.length > 0) lines.push('', t('handoff.codeState', { codeState }))
  return lines.join('\n')
}

/** 注入回主agent 的那段话：指挥员的原始指令 + 一句边界说明。 */
export function renderInstruction(reply, t) {
  const translate = pickT(t)
  const text = String(reply ?? '').trim()
  return [
    translate('handoff.instructionHeader'),
    '',
    text.length > 0 ? text : translate('handoff.emptyReply'),
    '',
    translate('handoff.instructionNote'),
  ].join('\n')
}

/**
 * 等指挥员回复之后该怎么办（纯决策，便于单测）。
 *
 * 三条硬规则：
 *   - `dead` / `timeout` → 停运，并且**必须清掉 pending**（否则留下脏记录）；
 *   - 等回复期间用户插话 → 让位一次，同样清掉 pending，不再注入；
 *   - 正常回复 → 注入指令，pending 由 waitCommander 自己清过。
 *
 * @returns {{action: 'wake'|'let-go'|'stop', clearPending: boolean, stopped: boolean}}
 */
export function afterWait(input = {}) {
  if (input.stopping === true) return { action: 'stop', clearPending: false, stopped: false }
  if (input.interrupted === true) return { action: 'let-go', clearPending: true, stopped: false }
  if (input.kind === 'dead' || input.kind === 'timeout') return { action: 'stop', clearPending: true, stopped: true }
  if (input.kind === 'reply') return { action: 'wake', clearPending: false, stopped: false }
  return { action: 'stop', clearPending: true, stopped: false }
}
