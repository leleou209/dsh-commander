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

export const DOC_FILES = ['suggest.md', 'history.md', 'plan.md', 'agent.md']

export const DOC_ROLES = {
  'suggest.md': '用户偏好与硬口径',
  'history.md': '已发生的实质行为（最新在上）',
  'plan.md': '当前计划与历史轮次',
  'agent.md': '设计导向与编辑行为分化',
}

/** 契约：三个令牌保持中文原样，它们是协议不是文案。 */
export const CONTRACT = [
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
    '你可以读全部文件、跑只读 shell、跑受控检查；可写但默认不动手，写只限 doc/。',
    '',
    '本轮是初始化预热。请只做一件事：把下面四个文件读一遍，了解这个项目。',
  ]
  for (const file of DOC_FILES) {
    lines.push(`- ${docDir}/${file} — ${DOC_ROLES[file]}`)
  }
  lines.push(
    '',
    `工作目录：${input.cwd ?? ''}`,
    '文件不存在就跳过，不要创建。',
    '',
    '读完只回一句「初始化完毕」，然后停住。',
    '不要开工、不要提方案、不要改任何文档、不要动 goal。',
    '接管挡位与本轮任务由用户随后亲口决定；在那之前不要产生任何连续行为。',
    '',
    '后续协作边界（一直有效）：',
    '- 你是**决策与验收方**，不是执行者，也不是并行劳动力；动手由主 agent 负责。',
    '- 需要多人并行推进时，让主 agent 用 agent team（subagent）拆活，不要要求它把工作一件件交给你。',
    '- 主 agent 不必为每件小事征得你同意：只有方向、验收、goal 变更这三类才需要你。',
  )
  const goal = String(input.goal ?? '').trim()
  if (goal.length > 0) lines.push('', `（参考：当前已有目标「${goal}」，但本轮不要推进它。）`)
  lines.push('', CONTRACT)
  return lines.join('\n')
}

/** 主agent 看到的工具说明：只留「是什么 + 动作 + 硬门禁 + 指路」。 */
export const TOOL_DESCRIPTION = [
  '决策托管：本会话有一个常驻指挥员（架构设计 + 督察验收）。',
  '动作：start 建立/接管；status 只读状态；list 列成员；say 发咨询；wait 等回复；',
  'cancel 取消等待；goal 管理目标；takeover 切接管挡位。',
  '硬门禁：部分/全接管下 goal 的 complete 要「允许结束」、edit/pause/blocked 要「批准：goal <动作>」；',
  'paused goal 只能由用户恢复。全接管下问用户前必须先 say。',
  // 三条"别把它当万能替补"的边界。没有这段时，主 agent 会把每件事都变成"问指挥员"。
  '它是决策与验收方，不是替补执行者：不要把自己的活交给它做，也不要为了等它一句话而停下手上的工作。',
  '需要并行推进（多个独立子任务、互不依赖的排查）时，用 subagent / agent team 拆出去并行做，而不是串行地问指挥员。',
  '只在三种情况用它：要它拍板方向、要它验收本轮产出、要它批准 goal 变更。',
].join('\n')
