/**
 * goal 与接管状态的联动（2.9.47）。
 *
 * 用户口径：强参与（partial/full）时指挥员接管 goal——进强管控要先做一次「覆写转译」；
 * 退到弱参与（observe/off）时 goal **自动暂停**，由用户重新驱动。这一层只做**纯决策**，
 * 真正的 goals.edit/create/pause 由调用方执行（便于穷举测试，也便于失败时不回滚接管状态）。
 *
 * 关键约束（宿主规则）：paused goal 只能由用户在界面恢复，模型无权 resume。
 * 所以「暂停后再进强参与」不能自动恢复，只能覆写 + 标记 needsResume，等用户点恢复。
 */

/** 会覆写 goal 的接管状态（强参与）。 */
export const STRONG_STATES = ['partial', 'full']

/** 覆写后的 objective 前缀：用它判断「这条 goal 是否已被接管模板覆盖过」。 */
export const TAKEOVER_MARK = '【接管：'

/** 这个接管状态是否属于强参与（由指挥员接管 goal）。 */
export function isStrongParticipation(state) {
  return STRONG_STATES.includes(state)
}

/** 这条 objective 是否已经被接管模板覆写过。 */
export function isTakeoverObjective(objective) {
  return typeof objective === 'string' && objective.startsWith(TAKEOVER_MARK)
}

/** 从覆写过的 objective 里取回原文（第 2 行到「执行边界」之前）。 */
export function stripTakeoverObjective(objective) {
  if (!isTakeoverObjective(objective)) return String(objective ?? '')
  const lines = String(objective).split('\n')
  const body = []
  for (const line of lines.slice(1)) {
    if (line.trim() === '执行边界：') break
    body.push(line)
  }
  return body.join('\n').trim()
}

/**
 * 生成覆写后的 objective（硬编码模板，幂等）。
 * @param {{state: string, original: string}} input
 */
export function buildTakeoverObjective(input = {}) {
  const state = input.state === 'full' ? '全接管' : '部分接管'
  const original = String(input.original ?? '').trim()
  const body = original.length > 0 ? original : '（原 goal 没有 objective；按用户本次指令执行）'
  const lines = [
    `${TAKEOVER_MARK}${state}】`,
    body,
    '',
    '执行边界：',
    '- 用户在当前对话里的直接指令优先于本目标；冲突时按用户的最新指令。',
    '- 指挥员负责方向与验收；主 agent 负责执行与汇报。',
  ]
  if (input.state === 'full') lines.push('- 全接管：可代用户拍板并驱动主 agent 继续，直到指挥员声明结束。')
  return lines.join('\n')
}

/**
 * 计算「切到某个接管状态时，goal 该怎么动」。
 *
 * @param {{state: string, goal?: {objective?: string, phase?: string} | undefined,
 *   origin?: string | undefined}} input
 * @returns {{action: 'none'|'create'|'edit'|'pause'|'restore-and-pause',
 *   objective?: string, origin?: string, needsResume?: boolean, reason?: string}}
 */
export function planGoalSync(input = {}) {
  const state = input.state
  const goal = input.goal
  const strong = isStrongParticipation(state)
  const origin = typeof input.origin === 'string' && input.origin.length > 0 ? input.origin : undefined
  if (strong) {
    // 已完成的 goal 不覆写：接管一个已经结束的目标没有意义，还会被宿主拒绝（edit 抛错）。
    if (goal !== undefined && goal.phase === 'complete') return { action: 'none', reason: 'phase-complete' }
    // 原 objective：接手前记录的 origin 优先；否则从已覆写的模板里还原，再退回当前 objective。
    const current = typeof goal?.objective === 'string' ? goal.objective : ''
    const base = origin ?? (isTakeoverObjective(current) ? stripTakeoverObjective(current) : current)
    const objective = buildTakeoverObjective({ state, original: base })
    if (goal === undefined) return { action: 'create', objective, origin: base }
    if (goal.objective === objective) return { action: 'none', reason: 'already-applied' }
    // 暂停中的 goal 不能由模型 resume：只覆写，标记等用户恢复。
    if (goal.phase === 'paused') return { action: 'edit', objective, origin: base, needsResume: true }
    return { action: 'edit', objective, origin: base }
  }
  // 弱参与：已经有 goal 才需要暂停；把 objective 还原回用户原文（如果有 origin）。
  if (goal === undefined) return { action: 'none', reason: 'no-goal' }
  if (goal.phase === 'paused' || goal.phase === 'complete') return { action: 'none', reason: `phase-${goal.phase}` }
  const current = typeof goal.objective === 'string' ? goal.objective : ''
  if (origin !== undefined && isTakeoverObjective(current)) {
    return { action: 'restore-and-pause', objective: origin, origin }
  }
  return { action: 'pause' }
}

/**
 * 把「接管状态 → goal 动作」执行出来（2.9.47）。
 *
 * 为什么单独成工厂：index.js 有 3100 行体量棘轮，这段有状态（origin 记忆）又需要宿主服务，
 * 放在这里既能单测，又不让 index 超行数。失败只回报，**不回滚接管状态、不抛给调用方**。
 *
 * @param {{ctx: any, rootSessionIdOf: (agent: any) => string}} deps
 */
export function createGoalSync({ ctx, rootSessionIdOf }) {
  /** leadSessionId -> 被覆盖前的原 objective。 */
  const origins = new Map()

  return async function sync(sessionId, state) {
    const agent = ctx.get('agents')?.get?.(sessionId)
    const goals = ctx.get('goals')
    if (!agent || !goals || typeof goals.create !== 'function') return { action: 'skipped' }
    try {
      const goal = goals.get(agent)
      const leadId = rootSessionIdOf(agent)
      const plan = planGoalSync({ state, goal, origin: origins.get(leadId) })
      if (plan.action === 'none') return { action: 'none', reason: plan.reason }
      if (plan.action === 'create') {
        goals.create(agent, { objective: plan.objective })
        if (plan.origin !== undefined) origins.set(leadId, plan.origin)
        return { action: 'create' }
      }
      const ref = { expectedRevision: goal.revision, goalId: goal.id }
      if (plan.action === 'edit') {
        goals.edit(agent, ref, { objective: plan.objective })
        if (plan.origin !== undefined) origins.set(leadId, plan.origin)
        return { action: 'edit', needsResume: plan.needsResume === true }
      }
      if (plan.action === 'restore-and-pause') {
        goals.edit(agent, ref, { objective: plan.objective })
        goals.pause(agent, { expectedRevision: goals.get(agent)?.revision })
        origins.delete(leadId)
        return { action: 'restore-and-pause' }
      }
      goals.pause(agent, ref)
      return { action: 'pause' }
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      ctx.logger?.warn?.(`dsh-commander: goal 联动失败（${state}）：${message}`)
      return { action: 'error', message }
    }
  }
}

/**
 * 挡位变化是否该动 goal（2.9.60）：只有**参与级别**真的变了才动。
 *
 * 用户/指挥员口径：weak→weak（初始化落地 observe、重复点 observe、HMR 丢内存后再点 ?）
 * 必须一个 goal 动作都不发——否则"再点一次不接管"就会把正在跑的目标静默暂停。
 * 强→强也不重复覆盖：goal 模板只在**进入**强参与时打一次。
 *
 * @param {string|undefined} before 生效中的旧挡位（无覆盖值时传 DEFAULT_TAKEOVER，不是 undefined）
 * @param {string|undefined} after 新挡位
 */
export function shouldSyncGoal(before, after) {
  return isStrongParticipation(before) !== isStrongParticipation(after)
}
