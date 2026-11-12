/**
 * 接管状态（takeover）：指挥员对主会话的接管程度。
 *
 * 四态（纯函数，便于单测；不依赖宿主）：
 *   off      无指挥    —— 没有指挥员 teammate，任何门禁都不生效
 *   observe  不接管    —— 指挥员在场当顾问，主agent完全自由
 *   partial  部分接管  —— 指挥员接管 goal 命令与放行
 *   full     全接管    —— 连「问用户」也收归指挥员：主agent必须先咨询
 *
 * 状态默认**推导**，允许用户显式覆盖；`source` 说明它从哪来，便于 status/doctor 解释。
 */

/** 允许的状态值（顺序即 `/commander takeover` 的循环顺序）。 */
export const TAKEOVER_STATES = ['off', 'observe', 'partial', 'full']

/** 用户可见的状态名。 */
export const TAKEOVER_LABELS = {
  off: '无指挥',
  observe: '不接管',
  partial: '部分接管',
  full: '全接管',
}

export const TAKEOVER_SOURCES = {
  derived: '推导',
  user: '你设定',
  auto: '自动降级',
}

/** 校验一个状态值；非法返回 undefined。 */
export function normalizeTakeover(value) {
  const text = String(value ?? '').trim().toLowerCase()
  return TAKEOVER_STATES.includes(text) ? text : undefined
}

/**
 * 推导当前接管状态。
 *
 * @param {object} input
 * @param {boolean} input.hasCommander 指挥员 teammate 是否存在
 * @param {boolean} [input.goalActive] goal 是否处于 active
 * @param {string} [input.override] 用户显式设定（会被 normalizeTakeover 校验）
 * @returns {{state: string, source: string}}
 */
export function resolveTakeover(input = {}) {
  const hasCommander = input.hasCommander === true
  if (!hasCommander) return { state: 'off', source: 'derived' }
  const override = normalizeTakeover(input.override)
  if (override) return { state: override, source: 'user' }
  return { state: input.goalActive === true ? 'partial' : 'observe', source: 'derived' }
}

/** 问用户是否需要先咨询指挥员（只有全接管时强制）。 */
export function requiresConsultBeforeAsking(state) {
  return state === 'full'
}

/** goal 的 complete/edit/pause/blocked 是否需要「允许结束」/「批准」。 */
export function requiresGoalApproval(state) {
  return state === 'partial' || state === 'full'
}

/**
 * 用户发来真实消息时的状态收敛：全接管自动降为部分接管（你在场，不必再挡）。
 * @returns {{state: string, source: string, downgraded: boolean}}
 */
export function onUserReturn(state, source) {
  if (state === 'full' && source === 'user') return { state: 'partial', source: 'auto', downgraded: true }
  return { state, source, downgraded: false }
}

/** 下一个状态（供 `/commander takeover` 与图标点击循环）。 */
export function nextTakeover(state) {
  const index = TAKEOVER_STATES.indexOf(normalizeTakeover(state) ?? 'off')
  return TAKEOVER_STATES[(index + 1) % TAKEOVER_STATES.length]
}
