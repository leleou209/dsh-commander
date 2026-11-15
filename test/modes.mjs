/**
 * 挡位判定真值表。核心不变量：weak→weak 零 goal 操作。
 */
import assert from 'node:assert/strict'
import { DEFAULT_MODE, LABELS, MODES, blockedWhenOff, isStrong, needsConsultBeforeAsk, needsGoalApproval, normalizeMode, resolveMode, shouldSyncGoal } from '../lib/modes.js'

const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('四态与默认值', () => {
  assert.deepEqual(MODES, ['off', 'observe', 'partial', 'full'])
  assert.equal(DEFAULT_MODE, 'observe')
  for (const mode of MODES) assert.ok(LABELS[mode].length > 0)
})

check('normalizeMode：大小写/空白容错，非法一律 undefined', () => {
  assert.equal(normalizeMode(' FULL '), 'full')
  assert.equal(normalizeMode('Off'), 'off')
  assert.equal(normalizeMode('nonsense'), undefined)
  assert.equal(normalizeMode(undefined), undefined)
  assert.equal(normalizeMode(''), undefined)
})

check('resolveMode：没有指挥员一律 off，门禁不生效', () => {
  assert.deepEqual(resolveMode({ hasCommander: false, override: 'full' }), { mode: 'off', source: 'derived' })
  assert.deepEqual(resolveMode({}), { mode: 'off', source: 'derived' })
})

check('resolveMode：有指挥员时显式值优先，否则默认 observe', () => {
  assert.deepEqual(resolveMode({ hasCommander: true }), { mode: 'observe', source: 'derived' })
  assert.deepEqual(resolveMode({ hasCommander: true, override: 'full', source: 'user' }), { mode: 'full', source: 'user' })
  assert.deepEqual(resolveMode({ hasCommander: true, override: 'partial' }), { mode: 'partial', source: 'user' })
  assert.equal(resolveMode({ hasCommander: true, override: 'bad' }).mode, 'observe')
})

check('强弱分类：partial/full 强，observe/off 弱', () => {
  assert.equal(isStrong('partial'), true)
  assert.equal(isStrong('full'), true)
  assert.equal(isStrong('observe'), false)
  assert.equal(isStrong('off'), false)
})

check('shouldSyncGoal：weak→weak 零操作（这是误暂停 goal 的根因）', () => {
  assert.equal(shouldSyncGoal('observe', 'observe'), false)
  assert.equal(shouldSyncGoal('off', 'observe'), false)
  assert.equal(shouldSyncGoal('observe', 'off'), false)
  assert.equal(shouldSyncGoal(undefined, 'observe'), false)
})

check('shouldSyncGoal：强→强不重复覆盖，强↔弱必须动', () => {
  assert.equal(shouldSyncGoal('full', 'full'), false)
  assert.equal(shouldSyncGoal('partial', 'full'), false)
  assert.equal(shouldSyncGoal('observe', 'full'), true)
  assert.equal(shouldSyncGoal('partial', 'observe'), true)
  assert.equal(shouldSyncGoal(undefined, 'partial'), true)
})

check('门禁开关：只有 full 拦问用户，partial/full 管 goal', () => {
  assert.equal(needsConsultBeforeAsk('full'), true)
  for (const mode of ['off', 'observe', 'partial']) assert.equal(needsConsultBeforeAsk(mode), false)
  assert.equal(needsGoalApproval('partial'), true)
  assert.equal(needsGoalApproval('full'), true)
  assert.equal(needsGoalApproval('observe'), false)
})

check('off 下只拒 say/wait，诊断类放行', () => {
  assert.equal(blockedWhenOff('say'), true)
  assert.equal(blockedWhenOff('wait'), true)
  for (const action of ['status', 'list', 'goal', 'takeover', 'start', 'cancel']) {
    assert.equal(blockedWhenOff(action), false)
  }
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
console.log(`\nMODES CHECKS PASSED (${checks.length})`)
