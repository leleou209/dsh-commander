/**
 * 接管状态（takeover）：指挥员对主会话的接管程度。
 *
 * 四态（纯函数，便于单测；不依赖宿主）：
 *   off      不运行指挥职责 —— 指挥员休息：say/wait 直接拒绝，任何门禁都不生效
 *   observe  不接管        —— 指挥员在场当顾问，主agent完全自由
 *   partial  部分接管      —— 指挥员接管 goal 命令与放行（启动时的默认）
 *   full     全接管        —— 连「问用户」也收归指挥员
 *
 * 状态只在「启动指挥」那一刻初始化（默认 partial），之后由用户显式切换；
 * 不跨进程沿用旧值——重启后回到初始化口径，不会把上一次的 full 复活。
 */

/** 允许的状态值（顺序即 `/commander takeover` 的循环顺序）。 */
export const TAKEOVER_STATES = ['off', 'observe', 'partial', 'full']

/** 用户可见的状态名。 */
export const TAKEOVER_LABELS = {
  off: '不运行指挥职责（无指挥）',
  observe: '不接管',
  partial: '部分接管',
  full: '全接管',
}

export const TAKEOVER_SOURCES = {
  derived: '推导',
  user: '你设定',
  init: '启动默认',
}

/** 启动指挥、且用户没指定状态时的初始化值。 */
export const DEFAULT_TAKEOVER = 'partial'

/**
 * off 下指挥员不运行职责：这些动作直接拒绝，并把「请自行思考」回给主agent。
 * 诊断类动作（status / doctor / checks / list / cancel）不受影响。
 */
export const OFF_BLOCKED_ACTIONS = ['say', 'wait']

/** 校验一个状态值；非法返回 undefined。 */
export function normalizeTakeover(value) {
  const text = String(value ?? '').trim().toLowerCase()
  return TAKEOVER_STATES.includes(text) ? text : undefined
}

/**
 * 推导当前接管状态。
 *
 * 没有指挥员 → off；有指挥员 → 显式覆盖值，否则启动默认值（partial）。
 * 这里不再看 goal：默认接管口径与「当前有没有 goal」无关，由用户显式选择决定。
 *
 * @param {object} input
 * @param {boolean} input.hasCommander 指挥员 teammate 是否存在
 * @param {string} [input.override] 显式设定（会被 normalizeTakeover 校验）
 * @param {string} [input.overrideSource] 这个设定从哪来（user / init），只用于展示
 * @returns {{state: string, source: string}}
 */
export function resolveTakeover(input = {}) {
  const hasCommander = input.hasCommander === true
  if (!hasCommander) return { state: 'off', source: 'derived' }
  const override = normalizeTakeover(input.override)
  if (override) {
    const source = typeof input.overrideSource === 'string' && input.overrideSource.length > 0 ? input.overrideSource : 'user'
    return { state: override, source }
  }
  return { state: DEFAULT_TAKEOVER, source: 'derived' }
}

/** 问用户是否需要先咨询指挥员（只有全接管时强制）。 */
export function requiresConsultBeforeAsking(state) {
  return state === 'full'
}

/** goal 的 complete/edit/pause/blocked 是否需要「允许结束」/「批准」。 */
export function requiresGoalApproval(state) {
  return state === 'partial' || state === 'full'
}

/** off 下这个动作是否被拒绝。 */
export function blockedWhenOff(action) {
  return OFF_BLOCKED_ACTIONS.includes(action)
}

