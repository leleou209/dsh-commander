/**
 * 门禁判定（2.9.40）：把「该不该拦」从宿主钩子里抽出来，变成纯函数。
 *
 * 为什么只抽判定、不搬钩子：
 *   - 守卫挂在 `tools.guard` / `tools.restrict` 上，搬注册顺序或作用域会让门禁
 *     **静默失效**（不报错、只是不拦），比崩溃更危险；
 *   - 判定逻辑本身依赖的只是几个显式输入（接管状态、批准集合、工具名、命令文本），
 *     抽出来就能穷举测试——这正是 `offline.mjs` 一直在替它做的事。
 *
 * 依赖方向：无 import（纯函数），钩子侧只做"收集输入 → 调用 → 返回原因"。
 */

/**
 * 这次工具调用是否应当让「允许结束」放行失效。
 *
 * 规则：写类工具（write/edit/apply_patch）直接失效；shell 命令若会改文件也失效。
 * @param {{toolName: string, shellTools?: string[], shellCommand?: string, shellViolation?: string|undefined, writeTools?: string[]}} input
 * @returns {boolean}
 */
export function invalidatesApproval(input = {}) {
  const writeTools = input.writeTools ?? ['write', 'edit', 'apply_patch']
  if (writeTools.includes(input.toolName)) return true
  const shellTools = input.shellTools ?? []
  if (!shellTools.includes(input.toolName)) return false
  const command = typeof input.shellCommand === 'string' ? input.shellCommand : ''
  return input.shellViolation !== undefined && command.length > 0
}

/**
 * 问用户门禁：全接管下必须先咨询指挥员。
 * @param {{toolName: string, takeoverState: string, consulted: boolean,
 *   requiresConsult: (state: string) => boolean, message: string}} input
 */
export function askUserDenial(input = {}) {
  if (input.toolName !== 'ask_user_question') return undefined
  if (!input.requiresConsult(input.takeoverState)) return undefined
  if (input.consulted === true) return undefined
  return input.message
}

/**
 * goal 变更门禁。
 *
 * 判定顺序（与 2.9.39 的行为逐条对应）：
 *   1. 关闭强制批准 / 非根会话 / 指挥员没启动 / 当前状态不接管 goal → 放行；
 *   2. complete：已有放行或已经 complete → 放行（幂等）；否则要放行；
 *   3. resume：永远由用户操作；
 *   4. edit/pause/blocked：有一次性批准就放行并消费；已经处于目标态 → 放行；
 *      否则要求批准。
 *
 * @param {{
 *   enforceApproval: boolean,
 *   isRoot: boolean,
 *   commanderStarted: boolean,
 *   takeoverState: string,
 *   requiresApproval: (state: string) => boolean,
 *   action: string,
 *   phase?: string,
 *   approvals?: Set<string>,
 *   released: boolean,
 *   consume?: boolean,
 *   messages: {needRelease: string, resumeByUser: string,
 *     needApproval: (action: string) => string, needApprovalPhase: (action: string, phase: string) => string},
 * @returns {string|undefined}
 */
export function goalGate(input = {}) {
  const {
    enforceApproval,
    isRoot,
    commanderStarted,
    takeoverState,
    requiresApproval,
    action,
    phase,
    approvals,
    released,
    consume = true,
    messages,
  } = input

  if (enforceApproval !== true) return undefined
  if (isRoot !== true) return undefined
  if (commanderStarted !== true) return undefined
  if (!requiresApproval(takeoverState)) return undefined

  if (action === 'complete') {
    if (released === true || phase === 'complete') return undefined
    return messages.needRelease
  }
  if (action === 'resume') return messages.resumeByUser
  if (action === 'edit' || action === 'pause' || action === 'blocked') {
    if (approvals !== undefined && approvals.has(action)) {
      if (consume) approvals.delete(action)
      return undefined
    }
    const targetPhase = action === 'blocked' ? 'blocked' : action === 'pause' ? 'paused' : undefined
    if (targetPhase !== undefined && phase === targetPhase) return undefined
    return phase !== undefined && phase.length > 0
      ? messages.needApprovalPhase(action, phase)
      : messages.needApproval(action)
  }
  return undefined
}

/**
 * 指挥员工具面门禁：只读工具集 + 写作用域 + 只读 shell。
 * @param {{toolName: string, isCommander: boolean, allowed?: Set<string>,
 *   writeVerdict?: string, shellVerdict?: string, denyReason: string}} input
 */
export function toolSurfaceDenial(input = {}) {
  const { toolName, isCommander, allowed, writeVerdict, shellVerdict, denyReason } = input
  if (!isCommander) return undefined
  if (allowed === undefined || !allowed.has(toolName)) return denyReason
  if (writeVerdict !== undefined) return writeVerdict
  if (shellVerdict !== undefined) return shellVerdict
  return undefined
}
