/**
 * 门禁真值表（2.9.40）。
 *
 * 为什么要有：守卫挂在宿主钩子上，出问题时表现是「不拦」而不是崩溃——最容易被忽略。
 * 这里对每道门禁穷举「该拦 / 不该拦」，把语义钉死；钩子只做转发（见 index.js）。
 *
 * 四道门禁：
 *   1. 放行失效（写工具 / 会改文件的 shell 命令）
 *   2. 问用户门禁（全接管下必须先咨询）
 *   3. goal 变更门禁（批准 / 放行 / 一次性消费 / 幂等）
 *   4. 指挥员工具面（只读工具集 / 写作用域 / 只读 shell）
 */

import assert from 'node:assert/strict'

import { askUserDenial, goalGate, invalidatesApproval, toolSurfaceDenial } from '../guards.js'

const checks = []
const check = (name, fn) => checks.push({ name, fn })

// ---- 1) 放行失效 ----
check('放行失效：写类工具一定失效', () => {
  for (const toolName of ['write', 'edit', 'apply_patch']) {
    assert.equal(invalidatesApproval({ toolName }), true, `${toolName} 必须让放行失效`)
  }
})

check('放行失效：只读工具/普通命令不失效', () => {
  assert.equal(invalidatesApproval({ toolName: 'read' }), false)
  assert.equal(invalidatesApproval({ toolName: 'grep' }), false)
  assert.equal(invalidatesApproval({ toolName: 'pwsh', shellTools: ['pwsh'], shellCommand: 'git status', shellViolation: undefined }), false)
})

check('放行失效：会改文件的 shell 命令失效', () => {
  assert.equal(
    invalidatesApproval({
      toolName: 'pwsh',
      shellTools: ['pwsh'],
      shellCommand: 'echo x > a.txt',
      shellViolation: '重定向',
    }),
    true,
  )
})

// ---- 2) 问用户门禁 ----
const requiresConsult = (state) => state === 'full'

check('问用户门禁：full 且未咨询 → 拦；已咨询 → 放行', () => {
  const base = { toolName: 'ask_user_question', requiresConsult, message: 'NEED_COMMANDER' }
  assert.equal(askUserDenial({ ...base, takeoverState: 'full', consulted: false }), 'NEED_COMMANDER')
  assert.equal(askUserDenial({ ...base, takeoverState: 'full', consulted: true }), undefined)
})

check('问用户门禁：partial/observe/off 一律放行', () => {
  for (const state of ['partial', 'observe', 'off']) {
    assert.equal(
      askUserDenial({ toolName: 'ask_user_question', takeoverState: state, consulted: false, requiresConsult, message: 'X' }),
      undefined,
      `${state} 下不该拦问用户`,
    )
  }
})

check('问用户门禁：其他工具不受影响', () => {
  assert.equal(
    askUserDenial({ toolName: 'read', takeoverState: 'full', consulted: false, requiresConsult, message: 'X' }),
    undefined,
  )
})

// ---- 3) goal 门禁 ----
const messages = {
  needRelease: 'NEED_RELEASE',
  resumeByUser: 'RESUME_BY_USER',
  needApproval: (action) => `NEED_APPROVAL:${action}`,
  needApprovalPhase: (action, phase) => `NEED_APPROVAL:${action}@${phase}`,
}

const goalBase = {
  enforceApproval: true,
  isRoot: true,
  commanderStarted: true,
  takeoverState: 'partial',
  requiresApproval: (state) => state === 'partial' || state === 'full',
  action: 'complete',
  phase: 'active',
  approvals: new Set(),
  released: false,
  messages,
}

check('goal 门禁：开关/非根/未启动/状态不接管 → 全放行', () => {
  assert.equal(goalGate({ ...goalBase, enforceApproval: false }), undefined)
  assert.equal(goalGate({ ...goalBase, isRoot: false }), undefined)
  assert.equal(goalGate({ ...goalBase, commanderStarted: false }), undefined)
  assert.equal(goalGate({ ...goalBase, takeoverState: 'observe' }), undefined)
})

check('goal 门禁：complete 没有放行 → 拦；有放行或已 complete → 放行（幂等）', () => {
  assert.equal(goalGate(goalBase), 'NEED_RELEASE')
  assert.equal(goalGate({ ...goalBase, released: true }), undefined)
  assert.equal(goalGate({ ...goalBase, phase: 'complete' }), undefined)
})

check('goal 门禁：resume 永远交给用户', () => {
  assert.equal(goalGate({ ...goalBase, action: 'resume', phase: 'paused' }), 'RESUME_BY_USER')
})

check('goal 门禁：edit/pause/blocked 有批准才放行，且一次性消费', () => {
  const approvals = new Set(['pause'])
  assert.equal(goalGate({ ...goalBase, action: 'pause', phase: 'active', approvals }), undefined)
  assert.equal(approvals.has('pause'), false, '批准必须被消费掉')
  // 第二次同动作：没有批准 → 拦
  assert.equal(goalGate({ ...goalBase, action: 'pause', phase: 'active', approvals }), 'NEED_APPROVAL:pause@active')
})

check('goal 门禁：已经处于目标态 → 放行（插件已代执行）', () => {
  assert.equal(goalGate({ ...goalBase, action: 'pause', phase: 'paused' }), undefined)
  assert.equal(goalGate({ ...goalBase, action: 'blocked', phase: 'blocked' }), undefined)
})

check('goal 门禁：没有 phase 时用无 phase 的提示文案', () => {
  assert.equal(goalGate({ ...goalBase, action: 'edit', phase: undefined }), 'NEED_APPROVAL:edit')
})

// ---- 4) 指挥员工具面 ----
check('工具面：非指挥员一律放行', () => {
  assert.equal(toolSurfaceDenial({ toolName: 'write', isCommander: false, allowed: new Set(), denyReason: 'DENY' }), undefined)
})

check('工具面：指挥员没拿到白名单或工具不在名单 → 拦', () => {
  assert.equal(toolSurfaceDenial({ toolName: 'write', isCommander: true, allowed: undefined, denyReason: 'DENY' }), 'DENY')
  assert.equal(
    toolSurfaceDenial({ toolName: 'write', isCommander: true, allowed: new Set(['read']), denyReason: 'DENY' }),
    'DENY',
  )
})

check('工具面：在白名单内时，写作用域/只读 shell 的判决照常生效', () => {
  const allowed = new Set(['write', 'pwsh'])
  assert.equal(toolSurfaceDenial({ toolName: 'write', isCommander: true, allowed, denyReason: 'DENY' }), undefined)
  assert.equal(
    toolSurfaceDenial({ toolName: 'write', isCommander: true, allowed, writeVerdict: 'SCOPE', denyReason: 'DENY' }),
    'SCOPE',
  )
  assert.equal(
    toolSurfaceDenial({ toolName: 'pwsh', isCommander: true, allowed, shellVerdict: 'SHELL', denyReason: 'DENY' }),
    'SHELL',
  )
})

let failed = 0
for (const { name, fn } of checks) {
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}\n       ${error && error.message ? error.message : error}`)
  }
}

if (failed > 0) {
  console.error(`\n${failed}/${checks.length} checks failed`)
  process.exit(1)
}
console.log(`\nGUARD CHECKS PASSED (${checks.length})`)
