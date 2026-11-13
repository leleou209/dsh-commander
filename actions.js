/**
 * action 注册表（2.9.39 P2）：**加一个 action 只改这一处**。
 *
 * 以前加一个 action 要改六处：schema enum、白名单数组、execute 分支、斜杠 verb、
 * usage 文案、README 表格。现在统一从这里派生：
 *   - `ACTION_IDS`      → schema enum / 白名单 / 未知 action 提示
 *   - `actionSegment()` → 工具 description 里的 action 段
 *   - `usageLines()`    → 斜杠命令的用法说明
 *   - `resolveSlash()`  → 斜杠 verb 与中文别名
 *   - `test/actions.mjs` 断言 README 工具表与 description 都跟这张表一致
 *
 * 依赖方向：无依赖（纯数据 + 纯函数），谁都可以 import。
 */

/**
 * @typedef {{
 *   id: string,
 *   summary: string,
 *   slash?: boolean,
 *   aliases?: string[],
 *   usage?: string,
 * }} ActionSpec
 */

/** @type {ActionSpec[]} */
export const ACTIONS = [
  { id: 'start', summary: '创建/接管', summaryEn: 'adopt', slash: true, aliases: ['启动', '开始'] },
  { id: 'list', summary: '列出成员', summaryEn: 'members', slash: true, aliases: ['列表'] },
  { id: 'say', summary: '发起咨询并登记 requestId', summaryEn: 'consult (registers a requestId)', slash: true, aliases: ['说', '问'] },
  { id: 'wait', summary: '无超时等待', summaryEn: 'untimed wait', slash: true, aliases: ['等待'] },
  { id: 'cancel', summary: '取消等待', summaryEn: 'cancel', slash: true, aliases: ['取消'] },
  { id: 'goal', summary: '管理 goal', summaryEn: 'manage', slash: false },
  { id: 'status', summary: '只读状态', summaryEn: 'status', slash: true, aliases: ['状态'] },
  { id: 'doctor', summary: '自检', summaryEn: 'self-check', slash: true, aliases: ['自检', '体检'] },
  { id: 'checks', summary: '跑受控检查', summaryEn: 'controlled checks', slash: true, aliases: ['检查'] },
  { id: 'handoff', summary: '交接探针', summaryEn: 'probe', slash: false },
  { id: 'help', summary: '取说明书（topic 可选）', summaryEn: 'manual (optional topic)', slash: true, aliases: ['帮助'] },
]

/** 工具可见的 action id（顺序即提示顺序）。 */
export const ACTION_IDS = ACTIONS.map((action) => action.id)

/** 工具 description 里的 action 段（唯一来源，中英各一份）。 */
export function actionSegment(locale = 'zh') {
  if (locale === 'en') {
    return `action: ${ACTIONS.map((action) => `${action.id} ${action.summaryEn}`).join('; ')}.`
  }
  return `action：${ACTIONS.map((action) => `${action.id} ${action.summary}`).join('；')}。`
}

/** 斜杠命令的用法行（唯一来源）。 */
export function usageLines(commandName) {
  return [
    `用法：/${commandName} <任意需求或问题>   ← 直接发给指挥员`,
    `      /${commandName} [${ACTION_IDS.join('|')}|takeover [状态]|record <摘要>]`,
    '不带参数只显示本说明（不会创建指挥员或 goal）。',
  ]
}

/**
 * 斜杠 verb 解析：英文 id 与中文别名都认。
 * @returns {{action: string, matched: boolean}} 未命中时 action 为空串（调用方按"整段当咨询"处理）
 */
export function resolveSlash(token) {
  const raw = String(token ?? '').trim()
  if (raw.length === 0) return { action: '', matched: false }
  const lower = raw.toLowerCase()
  const hit = ACTIONS.find(
    (action) => action.slash === true && (action.id === lower || (action.aliases ?? []).includes(raw)),
  )
  return hit ? { action: hit.id, matched: true } : { action: '', matched: false }
}

/** 供测试用：README 工具表里应当出现的 action 行。 */
export function readmeRows() {
  return ACTIONS.map((action) => `| \`${action.id}\` |`)
}
