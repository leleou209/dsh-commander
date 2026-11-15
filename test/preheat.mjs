/**
 * 预热代价 + goal 联动决策。
 */
import assert from 'node:assert/strict'
import { summarizePreheat, sumTokens } from '../lib/preheat.js'
import { buildTakeoverObjective, isTakeoverObjective, planGoalSync, stripTakeoverObjective } from '../lib/goal-link.js'

const checks = []
const check = (name, fn) => checks.push({ name, fn })

const events = [
  { type: 'session', time: 1_000 },
  { type: 'step/start', time: 1_020 },
  { type: 'tool/call', time: 1_100 },
  { type: 'assistant/message', time: 1_200, data: { usage: { inputTokens: 900, outputTokens: 120, cacheReadTokens: 5_000 } } },
  { type: 'step/start', time: 1_500 },
  { type: 'tool/call', time: 1_600 },
  { type: 'assistant/message', time: 1_900, data: { usage: { inputTokens: 800, outputTokens: 90 } } },
]
const ended = { type: 'turn/end', time: 2_000, data: { reason: { kind: 'completed' } } }

check('预热：进行中/完成/失败三态与计数', () => {
  const running = summarizePreheat({ createdAt: 1_000, events })
  assert.equal(running.state, 'running')
  assert.equal(running.steps, 2)
  assert.equal(running.tools, 2)
  assert.equal(running.ms, 900)
  assert.deepEqual(running.tokens, { input: 1_700, output: 210, cacheRead: 5_000, total: 1_910 })
  assert.equal(summarizePreheat({ createdAt: 1_000, events: [...events, ended] }).state, 'done')
  const failed = summarizePreheat({ createdAt: 1_000, events: [...events, { type: 'turn/end', time: 2_000, data: { reason: { kind: 'error' } } }] })
  assert.equal(failed.state, 'failed')
})

check('预热时长停在第一轮 turn/end（否则重启后读旧会话会显示几百小时）', () => {
  const later = summarizePreheat({
    createdAt: 1_000,
    events: [...events, ended, { type: 'turn/start', time: 900_000 }, { type: 'assistant/message', time: 900_100 }],
  })
  assert.equal(later.ms, 1_000)
})

check('预热：空事件返回 undefined，不编数字；缺 usage 不炸', () => {
  assert.equal(summarizePreheat({ createdAt: 1, events: [] }), undefined)
  assert.equal(summarizePreheat(), undefined)
  assert.deepEqual(sumTokens([{ type: 'assistant/message' }, { type: 'tool/call' }]), { input: 0, output: 0, cacheRead: 0, total: 0 })
})

check('goal 模板：幂等、可还原用户原文', () => {
  const objective = buildTakeoverObjective({ mode: 'full', original: '把登录修好' })
  assert.ok(isTakeoverObjective(objective))
  assert.ok(objective.includes('全接管'))
  assert.equal(stripTakeoverObjective(objective), '把登录修好')
  assert.equal(buildTakeoverObjective({ mode: 'full', original: '把登录修好' }), objective, '同输入必须同输出')
  assert.equal(stripTakeoverObjective('用户原文'), '用户原文')
})

check('planGoalSync 强参与：无 goal→create，有 goal→edit，paused 标记 needsResume', () => {
  assert.equal(planGoalSync({ mode: 'full', goal: undefined }).action, 'create')
  const goal = { objective: '原文', phase: 'active', revision: 1, id: 'g' }
  assert.equal(planGoalSync({ mode: 'partial', goal }).action, 'edit')
  assert.equal(planGoalSync({ mode: 'full', goal: { ...goal, phase: 'paused' } }).needsResume, true)
  assert.equal(planGoalSync({ mode: 'full', goal: { ...goal, phase: 'complete' } }).action, 'none')
  const applied = buildTakeoverObjective({ mode: 'full', original: '原文' })
  assert.equal(planGoalSync({ mode: 'full', goal: { ...goal, objective: applied } }).reason, 'already-applied')
})

check('planGoalSync 弱参与：有 active goal 才暂停；有 origin 则先还原', () => {
  assert.equal(planGoalSync({ mode: 'observe', goal: undefined }).reason, 'no-goal')
  const goal = { objective: '原文', phase: 'active', revision: 1, id: 'g' }
  assert.equal(planGoalSync({ mode: 'observe', goal }).action, 'pause')
  assert.equal(planGoalSync({ mode: 'off', goal: { ...goal, phase: 'paused' } }).action, 'none')
  const covered = { ...goal, objective: buildTakeoverObjective({ mode: 'full', original: '原文' }) }
  const restore = planGoalSync({ mode: 'observe', goal: covered, origin: '原文' })
  assert.equal(restore.action, 'restore-and-pause')
  assert.equal(restore.objective, '原文')
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
console.log(`\nPREHEAT + GOAL-LINK CHECKS PASSED (${checks.length})`)
