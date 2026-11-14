/**
 * goal ↔ 接管状态联动单测（2.9.47）。
 *
 * 用户口径：强参与（partial/full）指挥员接管 goal，进强管控要「覆写转译」；
 * 退到弱参与（observe/off）goal 自动暂停；paused 只能用户恢复，模型不 resume。
 */

import assert from 'node:assert/strict'

import {
  buildTakeoverObjective,
  createGoalSync,
  isStrongParticipation,
  isTakeoverObjective,
  planGoalSync,
  shouldSyncGoal,
  TAKEOVER_MARK,
} from '../lib/goal-link.js'

const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('强弱参与分类：partial/full 是强，observe/off 是弱', () => {
  assert.equal(isStrongParticipation('partial'), true)
  assert.equal(isStrongParticipation('full'), true)
  assert.equal(isStrongParticipation('observe'), false)
  assert.equal(isStrongParticipation('off'), false)
  assert.equal(isStrongParticipation(undefined), false)
})

check('覆写模板：带接管标记、保留原 objective、幂等', () => {
  const once = buildTakeoverObjective({ state: 'partial', original: '把插件做到 3.0' })
  assert.ok(once.startsWith(TAKEOVER_MARK), '必须带接管标记')
  assert.ok(once.includes('把插件做到 3.0'), '原 objective 必须保留')
  assert.ok(isTakeoverObjective(once))
  assert.equal(buildTakeoverObjective({ state: 'partial', original: '把插件做到 3.0' }), once, '同输入必须同输出')
  const full = buildTakeoverObjective({ state: 'full', original: 'x' })
  assert.ok(full.includes('全接管'), 'full 要写明全接管')
  assert.ok(full.includes('代用户拍板'), 'full 允许代拍板')
  assert.ok(!buildTakeoverObjective({ state: 'partial', original: 'x' }).includes('代用户拍板'), 'partial 不允许代拍板')
})

check('没有 goal + 强参与 → create', () => {
  const plan = planGoalSync({ state: 'full', goal: undefined })
  assert.equal(plan.action, 'create')
  assert.ok(isTakeoverObjective(plan.objective))
})

check('有活跃 goal + 强参与 → edit，并记下原 objective 作为 origin', () => {
  const plan = planGoalSync({ state: 'partial', goal: { objective: '原目标', phase: 'active', revision: 3 } })
  assert.equal(plan.action, 'edit')
  assert.equal(plan.origin, '原目标')
  assert.ok(plan.objective.includes('原目标'))
})

check('已经覆写过 → none（幂等，不重复改）', () => {
  const applied = buildTakeoverObjective({ state: 'partial', original: '原目标' })
  const plan = planGoalSync({ state: 'partial', goal: { objective: applied, phase: 'active' } })
  assert.equal(plan.action, 'none')
  assert.equal(plan.reason, 'already-applied')
})

check('paused goal + 强参与 → 只 edit 并标记 needsResume（模型不 resume）', () => {
  const plan = planGoalSync({ state: 'full', goal: { objective: '原目标', phase: 'paused' } })
  assert.equal(plan.action, 'edit')
  assert.equal(plan.needsResume, true)
})

check('已完成的 goal + 强参与 → none（不覆写已结束的目标）', () => {
  const plan = planGoalSync({ state: 'full', goal: { objective: '已完成的目标', phase: 'complete' } })
  assert.equal(plan.action, 'none')
  assert.equal(plan.reason, 'phase-complete')
})
check('弱参与 + 活跃 goal → pause', () => {
  assert.equal(planGoalSync({ state: 'observe', goal: { objective: 'x', phase: 'active' } }).action, 'pause')
  assert.equal(planGoalSync({ state: 'off', goal: { objective: 'x', phase: 'active' } }).action, 'pause')
})

check('弱参与 + 已被覆写 → 先还原原文再 pause', () => {
  const applied = buildTakeoverObjective({ state: 'full', original: '原目标' })
  const plan = planGoalSync({ state: 'observe', goal: { objective: applied, phase: 'active' }, origin: '原目标' })
  assert.equal(plan.action, 'restore-and-pause')
  assert.equal(plan.objective, '原目标')
})

check('弱参与 + 没有 goal / 已 paused / 已 complete → none', () => {
  assert.equal(planGoalSync({ state: 'off', goal: undefined }).action, 'none')
  assert.equal(planGoalSync({ state: 'off', goal: { objective: 'x', phase: 'paused' } }).action, 'none')
  assert.equal(planGoalSync({ state: 'off', goal: { objective: 'x', phase: 'complete' } }).action, 'none')
})

check('createGoalSync：没有 agents/goals 服务时静默跳过，不抛错', async () => {
  const ctx = { get: () => undefined }
  const sync = createGoalSync({ ctx, rootSessionIdOf: () => 'root-1' })
  assert.deepEqual(await sync('root-1', 'partial'), { action: 'skipped' })
})

check('createGoalSync：goal 操作抛错时只回报，不向上抛（接管状态不回滚）', async () => {
  const ctx = {
    get(name) {
      if (name === 'agents') return { get: () => ({ id: 'root-1', session: { header: { id: 'root-1' } } }) }
      if (name === 'goals') {
        return {
          create: () => {
            throw new Error('boom')
          },
          get: () => undefined,
        }
      }
      return undefined
    },
    logger: { warn: () => {} },
  }
  const sync = createGoalSync({ ctx, rootSessionIdOf: () => 'root-1' })
  const result = await sync('root-1', 'full')
  assert.equal(result.action, 'error')
  assert.match(result.message, /boom/)
})

check('shouldSyncGoal（2.9.60）：只有参与级别变了才动 goal', () => {
  // weak→weak：初始化落地、重复点「不接管」、HMR 丢内存后再点 ? —— 一个 goal 动作都不许发
  assert.equal(shouldSyncGoal('observe', 'observe'), false)
  assert.equal(shouldSyncGoal('off', 'observe'), false)
  assert.equal(shouldSyncGoal('observe', 'off'), false)
  // 强→强：模板只在进入强参与时打一次，不重复覆盖
  assert.equal(shouldSyncGoal('full', 'full'), false)
  assert.equal(shouldSyncGoal('partial', 'full'), false)
  // 强↔弱：必须动 goal
  assert.equal(shouldSyncGoal('observe', 'full'), true)
  assert.equal(shouldSyncGoal('partial', 'observe'), true)
  // 旧值缺省按弱参与处理（与 resolveTakeover 的默认口径一致）
  assert.equal(shouldSyncGoal(undefined, 'observe'), false)
  assert.equal(shouldSyncGoal(undefined, 'partial'), true)
})
let failed = 0
for (const { name, fn } of checks) {
  try {
    await fn()
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
console.log(`\nGOAL LINK CHECKS PASSED (${checks.length})`)