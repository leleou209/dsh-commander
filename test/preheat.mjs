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

check('重启后退出接管：没有 origin 也要把「接管」那句剥掉（否则一直念念不忘）', () => {
  const covered = {
    objective: buildTakeoverObjective({ mode: 'partial', original: '把登录页重做完' }),
    phase: 'active', revision: 3, id: 'g',
  }
  // origins 只在进程内存里，重启后是空的 —— 这正是"退出接管还去找指挥员"的机制。
  const plan = planGoalSync({ mode: 'observe', goal: covered })
  assert.equal(plan.action, 'restore-and-pause', '必须还原，不能只 pause 把覆写文本留着')
  assert.equal(plan.objective, '把登录页重做完')
  assert.equal(plan.objective.includes('指挥员负责方向'), false, '还原后不得残留指挥员口径')

  // 原本就没有 objective 的会话：占位符不还回去，只 pause。
  const placeholderGoal = {
    objective: buildTakeoverObjective({ mode: 'partial', original: '' }),
    phase: 'active', revision: 1, id: 'g2',
  }
  assert.equal(planGoalSync({ mode: 'observe', goal: placeholderGoal }).action, 'pause')

  // 没被覆写过的普通 goal 也不该被动 objective。
  assert.equal(planGoalSync({ mode: 'observe', goal: { objective: '普通目标', phase: 'active', revision: 1 } }).action, 'pause')

  // 已经 paused 的 goal 同样要收拾：暂停不等于免于还原（本会话 goal 就是这个状态）。
  const pausedCovered = { ...covered, phase: 'paused' }
  const pausedPlan = planGoalSync({ mode: 'observe', goal: pausedCovered })
  assert.equal(pausedPlan.action, 'restore', 'paused 也要还原 objective')
  assert.equal(pausedPlan.objective, '把登录页重做完')
  // 已完成的 goal 不碰：宿主会拒绝 edit。
  assert.equal(planGoalSync({ mode: 'observe', goal: { ...covered, phase: 'complete' } }).action, 'none')
})

check('接管模板要求主agent 用 team 并行，而不是把活交回指挥员', () => {
  for (const mode of ['partial', 'full']) {
    const text = buildTakeoverObjective({ mode, original: 'x' })
    assert.ok(text.includes('agent team'), `${mode} 模板必须点名 agent team`)
    assert.ok(text.includes('subagent'), `${mode} 模板必须点名 subagent`)
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
console.log(`\nPREHEAT + GOAL-LINK CHECKS PASSED (${checks.length})`)
