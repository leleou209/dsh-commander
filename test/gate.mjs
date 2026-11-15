/**
 * 门禁真值表：每道门「该拦 2 条 + 不该拦 2 条」。
 * 门禁静默失效比崩溃更危险，所以这里穷举边界。
 */
import assert from 'node:assert/strict'
import { askUserDenial, ensureAbortSignal, goalGate, invalidatesApproval, readOnlyShellViolation, toolSurfaceDenial, writeScopeViolation } from '../lib/gate.js'

const checks = []
const check = (name, fn) => checks.push({ name, fn })

const messages = {
  needRelease: 'NEED_RELEASE',
  resumeByUser: 'RESUME_BY_USER',
  needApproval: (action) => `NEED_${action}`,
  needApprovalPhase: (action, phase) => `NEED_${action}_${phase}`,
}
const gate = (over = {}) => goalGate({
  enforceApproval: true, isRoot: true, hasCommander: true, mode: 'partial',
  action: 'complete', released: false, messages, ...over,
})

check('goalGate：四个前置条件任一不满足就放行', () => {
  assert.equal(gate({ enforceApproval: false }), undefined)
  assert.equal(gate({ isRoot: false }), undefined)
  assert.equal(gate({ hasCommander: false }), undefined)
  assert.equal(gate({ mode: 'observe' }), undefined)
  assert.equal(gate({ mode: 'off' }), undefined)
})

check('goalGate complete：要放行；已放行或已完成则幂等放行', () => {
  assert.equal(gate(), 'NEED_RELEASE')
  assert.equal(gate({ released: true }), undefined)
  assert.equal(gate({ phase: 'complete' }), undefined)
  assert.equal(gate({ mode: 'full' }), 'NEED_RELEASE')
})

check('goalGate resume：永远交用户（宿主规则）', () => {
  assert.equal(gate({ action: 'resume' }), 'RESUME_BY_USER')
  assert.equal(gate({ action: 'resume', released: true }), 'RESUME_BY_USER')
})

check('goalGate edit/pause/blocked：一次性批准用掉即失效', () => {
  const approvals = new Set(['pause'])
  assert.equal(gate({ action: 'pause', approvals }), undefined)
  assert.equal(approvals.has('pause'), false, '批准必须被消费')
  assert.equal(gate({ action: 'pause', approvals }), 'NEED_pause')
  // consume:false 时不消费（预检用）
  const kept = new Set(['edit'])
  assert.equal(gate({ action: 'edit', approvals: kept, consume: false }), undefined)
  assert.equal(kept.has('edit'), true)
})

check('goalGate：已处于目标态则幂等放行', () => {
  assert.equal(gate({ action: 'pause', phase: 'paused' }), undefined)
  assert.equal(gate({ action: 'blocked', phase: 'blocked' }), undefined)
  assert.equal(gate({ action: 'pause', phase: 'active' }), 'NEED_pause_active')
  assert.equal(gate({ action: 'edit', phase: 'active' }), 'NEED_edit_active')
})

check('goalGate：create/clear 不受门禁', () => {
  assert.equal(gate({ action: 'create' }), undefined)
  assert.equal(gate({ action: 'clear' }), undefined)
})

check('askUserDenial：只有 full 且未咨询才拦', () => {
  const base = { toolName: 'ask_user_question', mode: 'full', consulted: false, message: 'ASK' }
  assert.equal(askUserDenial(base), 'ASK')
  assert.equal(askUserDenial({ ...base, consulted: true }), undefined)
  assert.equal(askUserDenial({ ...base, mode: 'partial' }), undefined)
  assert.equal(askUserDenial({ ...base, toolName: 'read' }), undefined)
})

check('invalidatesApproval：写工具 / 会改文件的 shell 让放行失效', () => {
  assert.equal(invalidatesApproval({ toolName: 'write' }), true)
  assert.equal(invalidatesApproval({ toolName: 'edit' }), true)
  assert.equal(invalidatesApproval({ toolName: 'read' }), false)
  assert.equal(invalidatesApproval({ toolName: 'pwsh', shellTools: ['pwsh'], shellCommand: 'rm x', shellViolation: 'x' }), true)
  assert.equal(invalidatesApproval({ toolName: 'pwsh', shellTools: ['pwsh'], shellCommand: 'ls' }), false)
})

check('readOnlyShellViolation：只读放行，写/重定向/未知命令拦下', () => {
  assert.equal(readOnlyShellViolation('ls -la'), undefined)
  assert.equal(readOnlyShellViolation('git status'), undefined)
  assert.equal(readOnlyShellViolation('Get-ChildItem | Select-Object Name'), undefined)
  assert.equal(readOnlyShellViolation(''), undefined)
  assert.ok(readOnlyShellViolation('echo x > a.txt'))
  assert.ok(readOnlyShellViolation('rm -rf x'))
  assert.ok(readOnlyShellViolation('git push'))
  assert.ok(readOnlyShellViolation('npm install left-pad'))
  assert.ok(readOnlyShellViolation('ls; rm x'), '分段后每段都要查')
})

check('toolSurfaceDenial：非指挥员不管；白名单外一律拒', () => {
  assert.equal(toolSurfaceDenial({ toolName: 'write', isCommander: false }), undefined)
  assert.equal(toolSurfaceDenial({ toolName: 'write', isCommander: true, allowed: new Set(['read']), denyReason: 'DENY' }), 'DENY')
  assert.equal(toolSurfaceDenial({ toolName: 'read', isCommander: true, allowed: new Set(['read']) }), undefined)
  assert.equal(toolSurfaceDenial({ toolName: 'read', isCommander: true, allowed: new Set(['read']), writeVerdict: 'W' }), 'W')
  assert.equal(toolSurfaceDenial({ toolName: 'read', isCommander: true, allowed: new Set(['read']), shellVerdict: 'S' }), 'S')
})

check('writeScopeViolation：只允许写 doc/ 之内', () => {
  const base = {
    toolName: 'write', cwd: '/w', writeScopes: ['doc'],
    toPosix: (p) => p.replace(/\\/g, '/'), resolvePath: (b, p) => (p.startsWith('/') ? p : `${b}/${p}`),
  }
  assert.equal(writeScopeViolation({ ...base, args: { file_path: 'doc/plan.md' } }), undefined)
  assert.equal(writeScopeViolation({ ...base, args: { file_path: '/w/doc/a/b.md' } }), undefined)
  assert.ok(writeScopeViolation({ ...base, args: { file_path: 'index.js' } }))
  assert.ok(writeScopeViolation({ ...base, args: { file_path: 'docs/plan.md' } }), 'docs 不等于 doc')
  assert.equal(writeScopeViolation({ ...base, toolName: 'read', args: { file_path: 'index.js' } }), undefined)
})

check('ensureAbortSignal：传入原样返回，缺省现造', () => {
  const controller = new AbortController()
  assert.equal(ensureAbortSignal(controller.signal), controller.signal)
  assert.ok(ensureAbortSignal(undefined) instanceof AbortSignal)
  assert.notEqual(ensureAbortSignal(undefined), ensureAbortSignal(undefined), '不共享，避免互相 abort')
})

let failed = 0
for (const { name, fn } of checks) {
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}\n       ${error?.message ?? error}`)
  }
}
if (failed > 0) {
  console.error(`\n${failed}/${checks.length} checks failed`)
  process.exit(1)
}
console.log(`\nGATE CHECKS PASSED (${checks.length})`)
