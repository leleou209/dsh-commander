/**
 * 门禁判定（纯函数，只 import 同层的 modes.js）。
 *
 * 为什么判定与钩子分开：守卫挂在 `tools.guard` / `tools.restrict` 上，
 * 搬注册顺序或作用域会让门禁**静默失效**（不报错、只是不拦），比崩溃更危险。
 * 判定只依赖几个显式输入，抽出来就能穷举测试；钩子侧只做「收集输入 → 调用 → 返回原因」。
 */

import { needsConsultBeforeAsk, needsGoalApproval } from './modes.js'

/** 会改文件的工具：一次调用就让「允许结束」放行失效。 */
const WRITE_TOOLS = ['write', 'edit', 'apply_patch', 'notebook_edit']

/**
 * 「问用户」类工具。宿主在不同版本里用过两个名字，两个都要拦，
 * 否则 full 挡位的承诺会漏掉一条通道。
 */
const ASK_TOOLS = new Set(['ask_user_question', 'request_user_input'])

/**
 * 宿主**原生** goal 工具。主 agent 手里有它们，所以门禁必须在工具层也生效——
 * 只挡 `commander(action="goal")` 那条自家通道是不够的：主 agent 完全可以直接
 * 调 `update_goal(action="complete")` 绕过指挥员（这正是"悄悄改目标/自己宣布完成"的入口）。
 *
 * 值是要从参数里取哪个字段当动作名；字符串表示固定动作。
 */
export const NATIVE_GOAL_TOOLS = { create_goal: 'create', update_goal: 'action' }

const GOAL_ACTIONS = ['create', 'edit', 'pause', 'resume', 'blocked', 'complete', 'clear']

/**
 * 把一次工具调用翻译成 goal 动作；不是 goal 工具就返回 undefined。
 * @returns {string|undefined}
 */
export function nativeGoalAction(toolName, args) {
  const spec = NATIVE_GOAL_TOOLS[toolName]
  if (spec === undefined) return undefined
  if (spec === 'create') return 'create'
  const action = String(args?.[spec] ?? '')
  return GOAL_ACTIONS.includes(action) ? action : undefined
}

/**
 * `off` 挡位的"指挥员休息"要连**直连**一起挡：主 agent 手里还有 `send_message`，
 * 只要知道指挥员的名字就能绕过 commander 工具把它叫起来。
 * 只在 off 挡位、且目标是本会话指挥员时拒绝。
 */
export function directMessageDenial(input = {}) {
  if (input.toolName !== 'send_message') return undefined
  if (input.mode !== 'off') return undefined
  if (typeof input.commanderName !== 'string' || input.commanderName.length === 0) return undefined
  const target = String(input.args?.agent ?? input.args?.target ?? '').trim()
  if (target !== input.commanderName) return undefined
  return `当前挡位是「不运行指挥职责」：指挥员在休息，不要直接给它发消息。先用 commander(action="takeover", state="observe") 把它叫回来。`
}

/**
 * 只读 shell 白名单。best-effort：按分隔符切段，每段首个词必须在表内，
 * 且整条命令不得出现输出重定向。**不是沙箱**，只是挡住"顺手改一下"。
 */
const READ_ONLY_COMMANDS = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'less', 'more', 'find', 'grep', 'rg',
  'Select-String', 'Get-Content', 'Get-ChildItem', 'Get-Item', 'Get-Location',
  'Test-Path', 'Measure-Object', 'Sort-Object', 'Where-Object', 'Format-Table',
  'Format-List', 'Select-Object', 'git', 'node', 'npm', 'echo', 'pwd', 'wc',
  'stat', 'file', 'diff', 'which', 'where', 'whoami', 'date', 'env',
])

/** git 只放行只读子命令。 */
const GIT_READ_ONLY = new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'ls-files', 'blame', 'tag'])

/**
 * @param {string} command
 * @returns {string|undefined} 违规原因；undefined 表示看起来只读
 */
export function readOnlyShellViolation(command) {
  const text = String(command ?? '').trim()
  if (text.length === 0) return undefined
  if (/>|>>/.test(text)) return '只读 shell 不允许输出重定向（> / >>）'
  const segments = text.split(/;|&&|\|\||\||\r?\n/).map((part) => part.trim()).filter((part) => part.length > 0)
  for (const segment of segments) {
    const words = segment.split(/\s+/)
    const head = words[0]
    if (!READ_ONLY_COMMANDS.has(head)) return `只读 shell 不允许命令 "${head}"`
    if (head === 'git' && !GIT_READ_ONLY.has(words[1] ?? '')) {
      return `只读 shell 不允许 git ${words[1] ?? ''}`
    }
    if ((head === 'npm' || head === 'node') && /\b(install|i|publish|link|uninstall)\b/.test(segment)) {
      return `只读 shell 不允许 ${head} 的安装/发布类子命令`
    }
  }
  return undefined
}

/**
 * 这次调用是否让「允许结束」放行失效：写类工具，或会改文件的 shell。
 */
export function invalidatesApproval(input = {}) {
  if (WRITE_TOOLS.includes(input.toolName)) return true
  const shellTools = input.shellTools ?? []
  if (!shellTools.includes(input.toolName)) return false
  const command = typeof input.shellCommand === 'string' ? input.shellCommand : ''
  return input.shellViolation !== undefined && command.length > 0
}

/** 问用户门禁：全接管下必须先咨询指挥员。 */
export function askUserDenial(input = {}) {
  if (!ASK_TOOLS.has(input.toolName)) return undefined
  if (!needsConsultBeforeAsk(input.mode)) return undefined
  if (input.consulted === true) return undefined
  return input.message
}

/**
 * goal 变更门禁。判定顺序：
 *   1. 关闭强制批准 / 非根会话 / 没有指挥员 / 当前挡位不管 goal → 放行；
 *   2. complete：已有放行或已 complete → 放行（幂等）；否则要放行；
 *   3. resume：永远由用户操作（宿主规则，模型无权恢复 paused goal）；
 *   4. edit/pause/blocked：有一次性批准就放行并消费；已在目标态 → 放行；否则要批准。
 *
 * @returns {string|undefined} 拒绝原因
 */
export function goalGate(input = {}) {
  const { enforceApproval, isRoot, hasCommander, mode, action, phase, approvals, released, consume = true, messages } = input
  if (enforceApproval !== true) return undefined
  if (isRoot !== true) return undefined
  if (hasCommander !== true) return undefined
  if (!needsGoalApproval(mode)) return undefined

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

/** 指挥员工具面：白名单 + 写作用域 + 只读 shell。 */
export function toolSurfaceDenial(input = {}) {
  const { toolName, isCommander, allowed, writeVerdict, shellVerdict, denyReason } = input
  if (isCommander !== true) return undefined
  if (allowed === undefined || !allowed.has(toolName)) return denyReason
  if (writeVerdict !== undefined) return writeVerdict
  if (shellVerdict !== undefined) return shellVerdict
  return undefined
}

/**
 * 写作用域：指挥员只能写 writeScopes 之内的路径。
 * @param {{toolName: string, args: any, cwd: string, writeScopes: string[],
 *   toPosix: (p: string) => string, resolvePath: (cwd: string, p: string) => string}} input
 */
export function writeScopeViolation(input = {}) {
  if (!WRITE_TOOLS.includes(input.toolName)) return undefined
  const raw = input.args?.file_path ?? input.args?.path ?? input.args?.notebook_path
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  const absolute = input.resolvePath(input.cwd, raw)
  const relative = input.toPosix(absolute).replace(input.toPosix(input.cwd).replace(/\/$/, '') + '/', '')
  const scopes = input.writeScopes ?? []
  if (scopes.some((scope) => relative === scope || relative.startsWith(scope.replace(/\/$/, '') + '/'))) return undefined
  return `指挥员只能写 ${scopes.join(' / ')} 之内；本次目标 ${relative}`
}

/**
 * 保证拿到真正的 AbortSignal。
 *
 * 宿主的 subagents 服务对每个入口校验 `signals[0] instanceof AbortSignal`，
 * 传 undefined 直接抛。图标路由触发的启动没有 exec signal，必须现造一个。
 * 传进来什么就原样返回（同一对象，便于调用方 abort 生效）。
 */
export function ensureAbortSignal(signal) {
  return signal ?? new AbortController().signal
}
