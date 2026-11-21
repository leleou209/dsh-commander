/**
 * 指挥员的常驻提示词。
 *
 * 口径（用户定的，2.9.57 起）：**初始化只是预热**。四大件给「路径 + 一句角色」，
 * 正文让它自己 read；读完只回一句「初始化完毕」就停 —— 不开工、不提方案、不改文档、
 * 不动 goal。模式与任务由用户随后亲口决定。
 *
 * 为什么不做披露式快照：把文档正文塞进提示词会让首轮注入涨到 ~19k 字符；
 * 给清单让它自己读，首轮约 1.6k 字符，而且它读到的是**当前**内容而不是快照。
 */

/**
 * 四大件的固定顺序与角色（用户定的口径）。
 *
 * `README.md` 不在其中：它是对外门面（安装/用法/许可），且**常驻载入**，
 * 所以"实例事实"这一格由 `suggest.md` 承担——按需读，不占每会话预算。
 */
export const DOC_FILES = ['agent.md', 'suggest.md', 'plan.md', 'history.md']

export const DOC_ROLES = {
  'agent.md': '公约：工作方式规则（计划自动执行、分块、提交、记录、验收）；每会话整体载入',
  'suggest.md': '实例事实：当前真实状态表、核心流程与边界、分层拓扑、目录与构建命令',
  'plan.md': '活动计划：状态口径、当前基线、阶段路线、工作项与出口验收（状态的唯一权威）',
  'history.md': '开发经历：每次建构的思路/结果/证据/边界，只追加、最新在上',
}

/** 契约：三个令牌保持中文原样，它们是协议不是文案。 */
const CONTRACT = [
  '回复格式（契约，令牌保持原样）：',
  '- 第一行回带请求号：[REQ <id>]（本轮没有请求号就写「无」）',
  '- 第二行给决议：决定：继续 / 决定：需澄清 / 决定：允许结束',
  '- 需要批准 goal 变更时写：批准：goal edit（可多个，逗号分隔）',
  '- 放行主agent 结束目标时写：允许结束',
].join('\n')

/**
 * @param {{cwd: string, docDir: string, name: string, goal?: string}} input
 */
export function buildCommanderPrompt(input = {}) {
  const docDir = String(input.docDir ?? 'doc').replace(/\/$/, '')
  const lines = [
    `你是本会话的指挥员（${input.name ?? 'commander'}），负责架构设计、方向判断与督察验收。`,
    '你可以读全部文件、跑只读 shell；写只能走 commander_record（doc/history.md）与 commander(action="plan")（doc/plan.md）。',
    '',
    '本轮是初始化预热。请只做一件事：把下面四个文件读一遍，了解这个项目。',
  ]
  for (const file of DOC_FILES) {
    lines.push(`- ${docDir}/${file} — ${DOC_ROLES[file]}`)
  }
  lines.push(
    '',
    `工作目录：${input.cwd ?? ''}`,
    // 四件套由插件在初始化时建好骨架（含公约与格式说明），这里只让指挥员去读，
    // 不要求它重建——否则每个项目都会被写成另一种流程。
    '这四个文件已由插件建好骨架；读一遍，把项目现状与公约装进判断里。',
    '',
    '读完只回一句「初始化完毕」，然后停住。',
    '不要开工、不要提方案、不要改任何文档、不要动 goal。',
    '接管挡位与本轮任务由用户随后亲口决定；在那之前不要产生任何连续行为。',
    '',
    '如果情况合适且用户不介意，可以适度督促主会话使用 agent team 并积极复用，提高工作效率。',
  )
  const goal = String(input.goal ?? '').trim()
  if (goal.length > 0) lines.push('', `（参考：当前已有目标「${goal}」，但本轮不要推进它。）`)
  lines.push('', CONTRACT)
  return lines.join('\n')
}

/**
 * 主会话与指挥员的关系声明。
 *
 * 规则只有一条：**它不影响 agent team**。主会话该拆并行就拆并行，不因为在场而收敛成
 * "凡事先问它"。建立时（start 的回应）再说一次，工具说明里也保留（每个请求都带，所以压到一行）。
 */
export const RELATION_NOTE =
  '关系声明：指挥员不影响 agent team 的运行，主会话仍按自己的需要推进 agent team 的使用。'

/** 主agent 看到的工具说明：只留「是什么 + 动作 + 硬门禁 + 指路」。 */
export const TOOL_DESCRIPTION = [
  '决策托管：本会话有一个常驻指挥员（架构设计 + 督察验收）。',
  '动作：start 建立/接管；status 只读状态；list 列成员；say 发咨询；wait 等回复；',
  'cancel 取消等待；goal 管理目标；takeover 切接管挡位。',
  '硬门禁：部分/全接管下 goal 的 complete 要「允许结束」、edit/pause/blocked 要「批准：goal <动作>」；',
  'paused goal 只能由用户恢复。全接管下问用户前必须先 say。',
  // 关系声明压到一行：这段每个请求都带，别在这里展开论述。
  RELATION_NOTE,
].join('\n')
