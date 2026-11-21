/**
 * 四大件文档的初始化与维护。
 *
 * **初始化要带内容，不是空壳。** 只写一行标题的文件等于没有公约：
 * 新项目的 agent.md 必须自己说明"四大文件怎么分工、git 怎么管、活怎么推"，
 * 否则每个 agent 都会自创一套流程，四大件也就白建了。
 *
 * 只做两件事：缺了就按模板建、history/plan 倒序追加。正文由人写，插件不代笔。
 */

import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { DOC_FILES, DOC_ROLES } from './prompt.js'

/** agent.md：项目开发公约。这是四个文件里唯一需要"每会话整体载入"的。 */
const AGENT_MD = `# agent.md — 项目开发公约

> 本文件约定本项目**怎么干活**：谁在什么时机做什么、怎么算做完。
> 它每会话整体载入，变更极低——改它等于改流程，别随手写。
> 本项目只有这一份 agent.md。

## 四大文件的分工

| 文件 | 放什么 | 变更频率 | 读法 |
| --- | --- | --- | --- |
| \`agent.md\` | 公约：工作方式规则（计划自动执行、分块、提交、记录、验收） | 极低，保持稳定 | 每会话整体载入 |
| \`suggest.md\` | 实例事实：当前真实状态表、核心流程与边界、分层拓扑、目录与构建命令 | 中 | 按需读 |
| \`plan.md\` | 活动计划：状态口径、当前基线、阶段路线、工作项与出口验收 | 高，但结构化 | 状态的唯一权威 |
| \`history.md\` | 开发经历：每次建构的思路/结果/证据/边界，追加式 | 高，只追加 | 按需读 |

\`README.md\` 是**对外门面**（安装、用法、许可），不属于四大文件；它同样全局唯一。

## 唯一性

- 四大文件与 \`README.md\` **全局唯一**：一个项目只有一份，放在仓库根或 \`doc/\` 下。
- 不在子目录、模块目录、临时实验目录里再放同名副本；需要分册就换名字（例如 \`doc/adr/0001-*.md\`）。
- 发现重复副本时：先确认哪份是权威（被引用、被 git 跟踪、内容最新的那份），合并后删掉其余。

## git 管理

- 开工前先看仓库状态：\`git status\` 干净、当前分支明确；不是仓库就先 \`git init\` 并提交一个初始快照。
- 一个可验证的改动一个提交；不把无关修改混进同一次提交。
- 提交信息写「做了什么 + 为什么」，不写 \`update\`、\`fix\` 这类空话。
- **不提交**凭据、令牌、\`node_modules\`、构建产物、个人环境文件；先补 \`.gitignore\` 再提交。
- 大范围重构前先开分支，完成后合并回主线，别让分支长期漂移。
- 提交前跑本项目的测试/自检；红了不提交。

## 推进方式

- 计划一旦写进 \`plan.md\` 就**自动执行**，不要每步请示；只在口径冲突、破坏性操作、需要外部依赖时停下问。
- 分块推进：一块做完就记 \`history.md\`（思路/结果/证据/边界），再进下一块。
- 验证先于声明：说「修好了」之前先给证据（测试输出、实测结果、文件哈希）。
- 验收按 \`plan.md\` 的出口条件逐条对，不按主观感觉。

## 编辑纪律

- 改文件前先读；改完只重读被改动的部分。
- 最小改动：不顺手重构无关代码，不批量改格式。
- 删除或覆盖前确认目标路径确实是想要的那个。
`

/** suggest.md：实例事实。只记实测，不记愿望。 */
const SUGGEST_MD = `# suggest.md — 实例事实

> 本项目**当前真实状态**——不是愿望，是实测。结构变了就更新它。
> 计划不放这里（计划在 \`plan.md\`）；这里只回答"现在是什么样"。

## 当前状态

如实填：做完了什么、还在什么程度、有什么已知缺陷。每行给得出证据。

| 模块/部件 | 状态 | 证据 |
| --- | --- | --- |
|  |  |  |

## 核心流程与边界

- 主流程：从入口到出口经过哪几步，谁是权威
- 明确不做 / 做不到：写清楚，免得后来的人反复试探
- 外部依赖：需要谁在场才能跑

## 分层拓扑

\`\`\`
（层与依赖方向；只画真实存在的，不要画设想的）
\`\`\`

## 目录与构建命令

- 关键目录：每个目录一句话
- 构建：
- 测试：
- 运行：

## 维护约定

- 只在**事实变了**的时候改，改就改到准确，不留半句"大概"。
- 结论要能复现：贴命令或贴输出，别只写"已验证"。
`

/** plan.md：状态的唯一权威。 */
const PLAN_MD = `# plan.md — 活动计划

> 一个工作项是待做 / 在做 / 已完成 / 阻塞，**以本文件为准**。
> 最新轮次在上；每轮写清状态口径、当前基线、阶段路线、工作项与出口验收。
> 计划写下来就自动执行，不要每步请示。

## 状态口径

四选一，不放形容词：待做 / 在做 / 已完成 / 阻塞。
"基本做完""差不多"这类说法不允许出现在状态里。

## 当前基线

动手前的真实起点：跑得通什么、跑不通什么、依赖谁。

## 阶段路线

- 阶段一：
- 阶段二：

## 工作项与出口验收

每条都要有**可验证的**出口条件（命令、输出、文件），否则不算验收。

- [ ] 工作项 — 出口条件

## 维护约定

- 计划变了就追加新一版（最新在上），不覆盖旧版：往下能看出计划怎么变过。
- 状态与事实不符时先改状态，再谈推进。
`

/** history.md：只追加。 */
const HISTORY_MD = `# history.md — 开发经历

> 只追加，最新在上。每条写清：做了什么、为什么、证据、边界（没做什么 / 遗留什么）。
> 不写计划、不写建议——计划在 \`plan.md\`，建议在 \`suggest.md\`。

## 记录格式

每条记录形如 \`## YYYY-MM-DD 标题\`，正文四行：

- **做了什么**：一句话说清改了什么
- **为什么**：解决什么问题，或满足什么要求
- **证据**：测试输出 / 实测结果 / 文件哈希，能复现的
- **边界**：这次没做什么、留下了什么、下次注意什么

## 为什么要这么记

下一轮的人（或下一个 agent）只有这里能知道"上次到哪了、为什么这么选"。
写完别人还要再猜一遍的记录，等于没记。
`

const TEMPLATES = {
  'agent.md': AGENT_MD,
  'suggest.md': SUGGEST_MD,
  'plan.md': PLAN_MD,
  'history.md': HISTORY_MD,
}

/** 缺文件时用哪份骨架：有模板用模板，没有就退化成标题 + 角色。 */
export function scaffoldFor(file) {
  const template = TEMPLATES[file]
  if (typeof template === 'string') return template
  return `# ${file.replace(/\.md$/, '')}\n\n> ${DOC_ROLES[file] ?? ''}\n`
}

/** 确保 doc/ 与四个文件存在；返回绝对路径表。已存在的文件**绝不覆盖**。 */
export async function ensureDocs(cwd, docDir = 'doc') {
  const dir = join(cwd, docDir)
  await fsp.mkdir(dir, { recursive: true })
  const paths = {}
  for (const file of DOC_FILES) {
    const full = join(dir, file)
    paths[file.replace(/\.md$/, '')] = full
    try {
      await fsp.access(full)
    } catch {
      await fsp.writeFile(full, scaffoldFor(file), 'utf8').catch(() => {})
    }
  }
  return paths
}

/**
 * 倒序追加一条记录（最新在上，插在标题与引言之后）。
 * 读不到原文件就整份重写，绝不因为一次写入失败把已有内容清掉。
 * `headerOf` 决定「文件不存在时用哪份骨架」，因此 history 与 plan 共用这一份实现。
 */
async function prependEntry(file, entry, headerOf = 'history.md') {
  const original = await fsp.readFile(file, 'utf8').catch(() => undefined)
  if (original === undefined) {
    await fsp.writeFile(file, `${scaffoldFor(headerOf)}\n${entry}\n`, 'utf8')
    return
  }
  const lines = original.split(/\r?\n/)
  let insertAt = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    // `## ` 是**第一条记录**（history 与 plan 的记录都用二级标题），不能当成文件头继续跳过。
    // 早先没这行判断，第二次写入会插进上一条记录的标题和正文之间。
    if (line.startsWith('##')) break
    if (line.startsWith('#') || line.startsWith('>') || line.length === 0) {
      insertAt = index + 1
      continue
    }
    break
  }
  const next = [...lines.slice(0, insertAt), '', entry, ...lines.slice(insertAt)]
  await fsp.writeFile(file, next.join('\n'), 'utf8')
}

/** 兼容旧调用点：history 的倒序追加。 */
export const prependHistory = (file, entry) => prependEntry(file, entry, 'history.md')

/** plan 的倒序追加（骨架用 plan.md 的头）。 */
export const prependPlan = (file, entry) => prependEntry(file, entry, 'plan.md')

const stamp = (now) =>
  `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

/** 一条 history 记录的格式。 */
export function formatHistoryEntry(summary, details, now = new Date()) {
  const lines = [`## ${stamp(now)}`, '', `- ${String(summary ?? '').trim()}`]
  const extra = String(details ?? '').trim()
  if (extra.length > 0) lines.push('', extra)
  return lines.join('\n')
}

/**
 * 一条 plan 记录的格式。
 *
 * 计划是**可演进的**，所以同样倒序追加、不覆盖旧版：最新一条就是当前计划，
 * 往下能看出计划怎么变过。标题可选，用于一句话概括这一版要解决什么。
 */
export function formatPlanEntry(plan, title, now = new Date()) {
  const heading = String(title ?? '').trim()
  const lines = [heading.length > 0 ? `## ${stamp(now)} · ${heading}` : `## ${stamp(now)}`, '', String(plan ?? '').trim()]
  return lines.join('\n')
}
