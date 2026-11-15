/**
 * 接管挡位（纯函数，无宿主依赖）。
 *
 * 四态语义：
 *   off      指挥员休息 —— say/wait 拒绝，任何门禁都不生效
 *   observe  在场当顾问 —— 主agent 完全自由
 *   partial  部分接管   —— goal 的 complete 要放行、edit/pause/blocked 要批准
 *   full     全接管     —— 连「问用户」也收归指挥员，且每轮自动交接
 *
 * 与老包的差别：这里**只有判定**，没有状态容器。挡位的存放与读写在 store.js，
 * 读路径是 async（HTTP/工具本来就是 async），只有 tools.guard 用同步快照。
 */

export const MODES = ['off', 'observe', 'partial', 'full']

export const LABELS = {
  off: '不运行指挥职责',
  observe: '不接管',
  partial: '部分接管',
  full: '全接管',
}

/** 建立指挥员后、用户还没选时的落地值。 */
export const DEFAULT_MODE = 'observe'

/** 强参与：指挥员接管 goal。 */
export const STRONG_MODES = ['partial', 'full']

/**
 * off 下直接拒绝的动作（诊断类与写文档不受影响）。
 *
 * `plan` 刻意不在里面：挡位管的是**和指挥员对话**这件事，不是文件写入。
 * 而且没有指挥员时推导挡位就是 off，把 plan 也挡掉会让「记录计划」在无指挥员时莫名其妙失效。
 */
const OFF_BLOCKED = ['say', 'wait']

export function normalizeMode(value) {
  const text = String(value ?? '').trim().toLowerCase()
  return MODES.includes(text) ? text : undefined
}

export function isStrong(mode) {
  return STRONG_MODES.includes(mode)
}

/**
 * 推导当前挡位。
 *
 * 没有指挥员 → off（门禁一律不生效）；有指挥员 → 显式值，否则默认 observe。
 * 不看 goal：接管宽度由用户显式选择，不跟着 goal 起落。
 */
export function resolveMode(input = {}) {
  if (input.hasCommander !== true) return { mode: 'off', source: 'derived' }
  const override = normalizeMode(input.override)
  if (override !== undefined) {
    const source = typeof input.source === 'string' && input.source.length > 0 ? input.source : 'user'
    return { mode: override, source }
  }
  return { mode: DEFAULT_MODE, source: 'derived' }
}

/**
 * 挡位变化是否该动 goal：只有**参与级别**真的变了才动。
 *
 * weak→weak（初始化落地、重复点「不接管」、重启后再点）必须零 goal 操作，
 * 否则会把用户正在跑的目标静默暂停；强→强也不重复覆盖模板。
 *
 * before 传「生效中的挡位」，不是可能为 undefined 的覆盖值。
 */
export function shouldSyncGoal(before, after) {
  return isStrong(before) !== isStrong(after)
}

/** 全接管下问用户必须先咨询指挥员。 */
export function needsConsultBeforeAsk(mode) {
  return mode === 'full'
}

/** goal 的 complete/edit/pause/blocked 是否需要放行/批准。 */
export function needsGoalApproval(mode) {
  return isStrong(mode)
}

export function blockedWhenOff(action) {
  return OFF_BLOCKED.includes(action)
}
