/**
 * 接管状态（takeover）单测：四态推导、门禁判定、用户回归降级、循环。
 */
import assert from 'node:assert/strict'
import {
  blockedWhenOff,
  DEFAULT_TAKEOVER,
  nextTakeover,
  normalizeTakeover,
  onUserReturn,
  requiresConsultBeforeAsking,
  requiresGoalApproval,
  resolveTakeover,
  TAKEOVER_LABELS,
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

check('有指挥员、没设过 → partial（启动默认）', () => {
  const { state, source } = resolveTakeover({ hasCommander: true })
  assert.equal(state, 'partial')
  assert.equal(state, DEFAULT_TAKEOVER)
  assert.equal(source, 'derived')
  assert.equal(requiresConsultBeforeAsking(state), false, 'partial 不拦问用户')
  assert.equal(requiresGoalApproval(state), true, 'partial 拦 goal 命令')
})

check('接管宽度不再跟 goal 走（有 goal 也是同一个默认值）', () => {
  assert.equal(resolveTakeover({ hasCommander: true, goalActive: false }).state, 'partial')
  assert.equal(resolveTakeover({ hasCommander: true, goalActive: true }).state, 'partial')
})

check('用户显式覆盖优先于推导', () => {
  const { state, source } = resolveTakeover({ hasCommander: true, goalActive: true, override: 'full' })
  assert.equal(state, 'full')
  assert.equal(source, 'user')
  assert.equal(requiresConsultBeforeAsking(state), true)
})

check('覆盖值非法时回落到启动默认值', () => {
  const { state, source } = resolveTakeover({ hasCommander: true, override: 'nonsense' })
  assert.equal(state, 'partial')
  assert.equal(source, 'derived')
})

check('没有指挥员时覆盖值不生效（不会留下幽灵 full）', () => {
  const { state, source } = resolveTakeover({ hasCommander: false, override: 'full' })
  assert.equal(state, 'off')
  assert.equal(source, 'derived')
})

check('off 下只拒绝 say / wait，诊断类动作照常', () => {
  assert.equal(blockedWhenOff('say'), true)
  assert.equal(blockedWhenOff('wait'), true)
  for (const action of ['status', 'doctor', 'checks', 'list', 'cancel', 'start', 'goal']) {
    assert.equal(blockedWhenOff(action), false, `${action} 不该被 off 拦`)
  }
})

check('四个状态都有中文名，off 明确写成"不运行指挥职责"', () => {
  for (const state of TAKEOVER_STATES) assert.equal(typeof TAKEOVER_LABELS[state], 'string')
  assert.match(TAKEOVER_LABELS.off, /不运行指挥职责/)
  assert.match(TAKEOVER_LABELS.off, /无指挥/)
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
