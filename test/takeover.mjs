/**
 * 接管状态（takeover）单测：四态推导、门禁判定、用户回归降级、循环。
 */
import assert from 'node:assert/strict'
import {
  nextTakeover,
  normalizeTakeover,
  onUserReturn,
  requiresConsultBeforeAsking,
  requiresGoalApproval,
  resolveTakeover,
  TAKEOVER_STATES,
} from '../takeover.js'

const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('没有指挥员 → off（任何门禁都不生效）', () => {
  const { state, source } = resolveTakeover({ hasCommander: false, goalActive: true })
  assert.equal(state, 'off')
  assert.equal(source, 'derived')
  assert.equal(requiresConsultBeforeAsking(state), false)
  assert.equal(requiresGoalApproval(state), false)
})

check('有指挥员、无 goal → observe（主agent完全自由）', () => {
  const { state, source } = resolveTakeover({ hasCommander: true, goalActive: false })
  assert.equal(state, 'observe')
  assert.equal(source, 'derived')
  assert.equal(requiresConsultBeforeAsking(state), false)
  assert.equal(requiresGoalApproval(state), false)
})

check('有指挥员、goal active → partial（接管 goal 命令）', () => {
  const { state } = resolveTakeover({ hasCommander: true, goalActive: true })
  assert.equal(state, 'partial')
  assert.equal(requiresConsultBeforeAsking(state), false, 'partial 不拦问用户')
  assert.equal(requiresGoalApproval(state), true, 'partial 拦 goal 命令')
})

check('用户显式覆盖优先于推导', () => {
  const { state, source } = resolveTakeover({ hasCommander: true, goalActive: true, override: 'full' })
  assert.equal(state, 'full')
  assert.equal(source, 'user')
  assert.equal(requiresConsultBeforeAsking(state), true)
})

check('覆盖值非法时回落到推导', () => {
  const { state, source } = resolveTakeover({ hasCommander: true, goalActive: false, override: 'nonsense' })
  assert.equal(state, 'observe')
  assert.equal(source, 'derived')
})

check('全接管是唯一强制先咨询的状态', () => {
  assert.deepEqual(
    TAKEOVER_STATES.map((state) => [state, requiresConsultBeforeAsking(state)]),
    [
      ['off', false],
      ['observe', false],
      ['partial', false],
      ['full', true],
    ],
  )
})

check('goal 门禁只在 partial/full 生效', () => {
  assert.deepEqual(
    TAKEOVER_STATES.map((state) => [state, requiresGoalApproval(state)]),
    [
      ['off', false],
      ['observe', false],
      ['partial', true],
      ['full', true],
    ],
  )
})

check('用户回来时 full 自动降为 partial', () => {
  const next = onUserReturn('full', 'user')
  assert.equal(next.state, 'partial')
  assert.equal(next.downgraded, true)
  assert.equal(next.source, 'auto')
})

check('非全接管 / 非用户来源不降级', () => {
  assert.equal(onUserReturn('partial', 'user').downgraded, false)
  assert.equal(onUserReturn('full', 'derived').downgraded, false)
})

check('循环顺序 off → observe → partial → full → off', () => {
  assert.equal(nextTakeover('off'), 'observe')
  assert.equal(nextTakeover('observe'), 'partial')
  assert.equal(nextTakeover('partial'), 'full')
  assert.equal(nextTakeover('full'), 'off')
  assert.equal(nextTakeover('nonsense'), 'observe', '非法值按 off 起算')
})

check('normalizeTakeover 大小写/空白容错', () => {
  assert.equal(normalizeTakeover('  FULL '), 'full')
  assert.equal(normalizeTakeover('Partial'), 'partial')
  assert.equal(normalizeTakeover('x'), undefined)
  assert.equal(normalizeTakeover(undefined), undefined)
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
console.log(`\nTAKEOVER CHECKS PASSED (${checks.length})`)
