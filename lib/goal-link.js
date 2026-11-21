/**
 * 挡位 → goal 的联动。纯决策 + 执行分开，便于穷举测试。
 *
 * 口径：进强参与（partial/full）时指挥员接管 goal，做一次「覆写转译」；
 * 退到弱参与（observe/off）时 goal 自动暂停，由用户重新驱动。
 *
 * 硬约束（宿主规则）：**paused goal 只能由用户在界面恢复，模型无权 resume。**
 * 所以「暂停后再进强参与」不能自动恢复，只能覆写 + 标记 needsResume。
 */

const TAKEOVER_MARK = '【接管：'

export function isTakeoverObjective(objective) {
  return typeof objective === 'string' && objective.startsWith(TAKEOVER_MARK)
}

/** 从覆写过的 objective 里取回用户原文（第 2 行到「执行边界」之前）。 */
export function stripTakeoverObjective(objective) {
  if (!isTakeoverObjective(objective)) return String(objective ?? '')
  const body = []
  for (const line of String(objective).split('\n').slice(1)) {
    if (line.trim() === '执行边界：') break
    body.push(line)
  }
  return body.join('\n').trim()
}

/** 生成覆写后的 objective（幂等模板）。 */
export function buildTakeoverObjective(input = {}) {
  const label = input.mode === 'full' ? '全接管' : '部分接管'
  const original = String(input.original ?? '').trim()
  const lines = [
    `${TAKEOVER_MARK}${label}】`,
    original.length > 0 ? original : '（原 goal 没有 objective；按用户本次指令执行）',
    '',
    '执行边界：',
    '- 用户在当前对话里的直接指令优先于本目标；冲突时按用户的最新指令。',
    '- 指挥员负责方向与验收；主 agent 负责执行与汇报。',
  ]
  if (input.mode === 'full') lines.push('- 全接管：可代用户拍板并驱动主 agent 继续，直到指挥员声明结束。')
  return lines.join('\n')
}

/**
 * 纯决策：切到某个挡位时 goal 该怎么动。
 * 调用方必须先用 shouldSyncGoal 判过「级别真的变了」，这里不再重复判。
 */
export function planGoalSync(input = {}) {
  const { mode, goal, origin } = input
  const strong = mode === 'partial' || mode === 'full'
  if (strong) {
    // 已结束的目标不覆写：这是产品选择（接管一个做完的目标没有意义）。
    // 注意宿主**允许** edit 一个 phase=complete 的 goal（实测 revision 会 +1），
    // 所以别把这条写成"宿主会拒绝"——真正拦住它的是这里。
    if (goal !== undefined && goal.phase === 'complete') return { action: 'none', reason: 'phase-complete' }
    const current = typeof goal?.objective === 'string' ? goal.objective : ''
    const base = origin ?? (isTakeoverObjective(current) ? stripTakeoverObjective(current) : current)
    const objective = buildTakeoverObjective({ mode, original: base })
    if (goal === undefined) return { action: 'create', objective, origin: base }
    if (goal.objective === objective) return { action: 'none', reason: 'already-applied' }
    if (goal.phase === 'paused') return { action: 'edit', objective, origin: base, needsResume: true }
    return { action: 'edit', objective, origin: base }
  }
  if (goal === undefined) return { action: 'none', reason: 'no-goal' }
  if (goal.phase === 'paused' || goal.phase === 'complete') return { action: 'none', reason: `phase-${goal.phase}` }
  const current = typeof goal?.objective === 'string' ? goal.objective : ''
  // 只有**记下了用户原文**才能还原。origin 为空（goal 是接管时自己建的占位）
  // 时不能 edit 成空串——宿主会以 GOAL_INVALID_OBJECTIVE 拒绝，结果就是
  // 「退出强参与后 goal 还亮着」。这种情况直接 pause，占位文案留着当记录。
  if (origin !== undefined && origin.trim().length > 0 && isTakeoverObjective(current)) {
    return { action: 'restore-and-pause', objective: origin }
  }
  return { action: 'pause' }
}

/**
 * 执行联动。失败只回报，**不回滚挡位、不抛给调用方**。
 * @param {{ctx: any, rootIdOf: (agent: any) => string}} deps
 */
export function createGoalSync({ ctx, rootIdOf }) {
  /** rootId -> 被覆盖前的用户原文。 */
  const origins = new Map()

  return async function sync(agent, mode) {
    const goals = ctx.get('goals')
    if (agent === undefined || goals === undefined || typeof goals.create !== 'function') {
      return { action: 'skipped' }
    }
    try {
      const goal = goals.get(agent)
      const rootId = rootIdOf(agent)
      const plan = planGoalSync({ mode, goal, origin: origins.get(rootId) })
      if (plan.action === 'none') return plan
      if (plan.action === 'create') {
        goals.create(agent, { objective: plan.objective })
        origins.set(rootId, plan.origin)
        return { action: 'create' }
      }
      // 宿主的 GoalRef 是 { id, revision }；写错字段会被宿主当成过期引用。
      const ref = { id: goal.id, revision: goal.revision }
      if (plan.action === 'edit') {
        goals.edit(agent, ref, { objective: plan.objective })
        origins.set(rootId, plan.origin)
        return { action: 'edit', needsResume: plan.needsResume === true }
      }
      if (plan.action === 'restore-and-pause') {
        goals.edit(agent, ref, { objective: plan.objective })
        // edit 让 revision +1，pause 必须用**新的** revision 再取一次。
        const after = goals.get(agent) ?? goal
        goals.pause(agent, { id: after.id, revision: after.revision })
        origins.delete(rootId)
        return { action: 'restore-and-pause' }
      }
      goals.pause(agent, ref)
      return { action: 'pause' }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-commander: goal 联动失败（${mode}）：${error?.message ?? error}`)
      return { action: 'error', message: error?.message ?? String(error) }
    }
  }
}
