/**
 * dsh-commander — 长线工作的「指挥员」插件（Host 插件）。
 *
 * 一个固定、可续接的 Agent Teams teammate（名字 commander），不是每轮派生子agent：
 *   - commander(action=start) 创建/接管，缺失时建 doc/{suggest,history,plan,agent}.md；
 *   - say 发起咨询并登记 pending，wait 无超时等待，工程组完成时临时 interrupt；
 *   - 决议协议：决定：继续 / 需澄清 / 允许结束；放行绑定代码状态，写操作使其失效；
 *   - goal 的 edit/pause/blocked 需要「批准：goal <动作>」；paused goal 只能由用户恢复；
 *   - 异常中断恢复时自动 rearm 原本 active 的 goal，用户主动中断不恢复。
 *
 * 接管状态（takeover）四态 off/observe/partial/full 决定哪些门禁生效：启动时初始化
 * （默认 partial），之后由用户在 composer 图标菜单里显式切换；只在内存里，不跨进程沿用。
 *
 * 指挥员工具面通过 tools.restrict + guard 收紧：读全盘、只读 shell、写仅限 doc/；
 * 该 teammate 是长期在线的指挥循环，不替代工程组。
 *
 * @module @local/dsh-commander
 */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMMANDER_CONTRACT, parseCodeState, parseDecision, parseGoalApprovals, parseRequestId } from './protocol.js'
import { computeCodeState, describeGitHead } from './code-state.js'
import { createStateStore, STATE_TABLES } from './state-store.js'
import {
  blockedWhenOff,
  DEFAULT_TAKEOVER,
  normalizeTakeover,
  nextTakeover,
  requiresConsultBeforeAsking,
  requiresGoalApproval,
  resolveTakeover,
  TAKEOVER_LABELS,
  TAKEOVER_SOURCES,
  TAKEOVER_STATES,
} from './takeover.js'
import { createTranslator, localeKeyDiff } from './messages.js'
import { classifyReply, commanderDead, HANDOFF_SOURCE, renderInstruction, renderReport, shouldHandoff } from './handoff.js'

/** 运行时版本标记：status 里显示，用来确认当前进程加载的是哪一版代码（HMR 是否生效）。 */
const PLUGIN_VERSION = '2.9.27'

/** 从 DSH 安装目录加载 schemastery；失败时插件仍可运行，只是 Plugin Manager 不显示 Config。 */
function loadSchemaLib() {
  const candidates = []
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'schemastery'))
    candidates.push(join(process.resourcesPath, 'app', 'dsh', 'node_modules', '@deepseek-ai', 'schemastery'))
  }
  candidates.push(join(process.cwd(), 'node_modules', '@deepseek-ai', 'schemastery'))
  for (const dir of candidates) {
    try {
      const req = createRequire(join(dir, 'package.json'))
      const mod = req(dir)
      const lib = mod?.default ?? mod
      if (typeof lib?.object === 'function') return lib
    } catch {
      // 尝试下一个位置
    }
  }
  return undefined
}

const Schema = loadSchemaLib()


import { promises as fsp } from 'node:fs'
import * as path from 'node:path'

export const name = 'dsh-commander'

/** 硬依赖：工具注册与子代理运行时。goals / agentDefaultModel / workingDirectory / llm 为可选。 */
export const inject = ['tools', 'subagents']

/** 单位置的 PTC 呈现传输名（受保护，不能出现在 restrict 名单中）。 */
const PTC_TRANSPORT = 'run_code'

/** goal 协作提醒标记，用于避免重复改写同一目标。 */
const GOAL_MARKER = '[指挥协作]'

/** 四份文档：文件名 -> 首部标题块。 */
const DOC_HEADERS = {
  suggest: [
    '# 建议板 suggest.md',
    '',
    '> 仅由用户编写；指挥员 每一轮都必须先读本文件；最新内容在最上方。',
    '> 每条建议请标注事件（时间或里程碑），例如：',
    '>',
    '> ## 2026-11-02 · 事件：登录接口改造',
    '>',
    '> - 建议：先补失败用例，再改实现。',
    '>',
    '> ## 2026-11-03 · 事件：发布前检查',
    '>',
    '> - 约束：不要改动 public API。',
    '',
  ].join('\n') + '\n',
  history: [
    '# 行动历史 history.md',
    '',
    '> 由主agent记录已完成的实质行为；最新内容在最上方。',
    '> 指挥员依据本文件判断进度，避免重复建议已完成的事项。',
    '',
  ].join('\n') + '\n',
  plan: [
    '# 计划板 plan.md',
    '',
    '> 由指挥员维护当前计划，并保留历史轮次留痕；最新内容在最上方。',
    '',
  ].join('\n') + '\n',
  agent: [
    '# 设计导向 agent.md',
    '',
    '> 由指挥员维护：编辑行为分化与整体设计导向；最新内容在最上方。',
    '',
  ].join('\n') + '\n',
}

const DOC_FILES = ['suggest', 'history', 'plan', 'agent']

/** 指挥员可用的只读工具名（按项目实际挂载情况取交集）。 */
const DEFAULT_READ_ONLY_TOOLS = [
  'read',
  'read_image',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  // 写权限：可以维护 doc/plan.md、doc/agent.md 等指挥留痕，但默认不建议动手。
  'write',
  'edit',
  'apply_patch',
]

const DEFAULT_GOAL_REMINDER = [
  GOAL_MARKER,
  '指挥员是唯一的决策入口：任何新任务/阶段开始前，先用 commander(action=say) 汇报目标与计划，再 commander(action=wait) 取得指令；不要先问用户。',
  '每完成一个可验收阶段，必须先向指挥员汇报（轮次/指令、改动、验证命令与结果、问题/风险、代码版本）并 wait；收到「继续」才进入下一轮，收到「允许结束」才交付。',
  '收到「继续」时分流：单点疑问/小 bug 直接修并简短回报，不要包装成批次；方向性/多步工作才按批次连续完成再汇报。',
  '批次内小取舍自行决定；只有整批完成、真正阻塞或需用户拍板才回报；不要为小问题走完整汇报仪式。',
  '向指挥员要下一批时，明确请求「给出一批可连续完成的工作」，并说明当前批次状态与剩余量。',
  '只有指挥员回「需澄清」或明确要求用户拍板时，才使用 ask_user_question；禁止用用户代替指挥员。未咨询指挥员就直接问用户，会被工具拒绝。',
  '如果需要用户输入（选方向、给时间窗、确认不可逆操作）：先 commander(action=say) 说明卡点并请求「暂时作结」，拿到指挥员的「决定：需澄清」+「批准：goal pause」后再暂停 goal、向用户提问、本轮结束。不要在等用户期间继续 goal 自动轮空转。',
  'wait 返回 interrupt 时只验收/记录已完成工作，不分发新工作，处理完再次 wait；用户中断后下一轮先看 commander status，有 pending 就恢复 wait（用户明确不再关注则 cancel）。',
  '允许结束必须回显 Lead 消息里的 CODE_STATE；每条回复头部还要有「请求：<REQ id>」，缺失或不匹配不会被采用；代码状态变化或写操作会让放行失效。',
  'goal 状态/内容变更（edit/pause/blocked）必须先取得指挥员「批准：goal <动作>」；paused goal 只能由用户在界面恢复，模型无权 resume；complete 只认「允许结束」。',
  '用户要求模糊时按最可能意图推断并执行，不要为显而易见的结论反复询问；只有不可逆/改变语义/成本高才澄清。',
  '正常推进时按 doc/plan.md 的下一步建议执行，并把进展记录到 doc/history.md；阶段完成/大改动/验收前提醒 Lead 执行 git 管理并检查 git status。',
  '工程组 / Agent Teams / 其他子agent 仍是执行主体，指挥员只做指挥，不要为等它而停止 goal。',
].join('')





const DEFAULT_CONFIG = {
  provider: 'spawn',
  commandToolName: 'commander',
  recordToolName: 'commander_record',
  commandName: 'commander',
  commanderName: 'commander',
  commanderTitle: '指挥员',
  advisorProvider: '',
  advisorModel: '',
  advisorReasoningEffort: '',
  docsDir: 'doc',
  writeScope: 'doc',
  goalMode: 'augment',
  goalReminder: DEFAULT_GOAL_REMINDER,
  readOnlyTools: DEFAULT_READ_ONLY_TOOLS,
  extraReadOnlyTools: [],
  shellTools: ['pwsh', 'bash'],
  enforceApproval: true,
  resumeOnAbnormal: true,
  maxSuggestChars: 4000,
  maxPlanChars: 3000,
  maxHistoryChars: 4000,
  maxOrientationChars: 3000,
  planSections: 1,
  historySections: 6,
  allowPtc: false,
  statePath: '',
  expectTranscriptWindow: false,
  locale: 'zh-CN',
  /** 受控检查命令（`name = command` 或直接 command）；只有这里列出的命令能被 checks 执行。 */
  checkCommands: [],
  checkTimeoutMs: 180000,
  stateMaxBytes: 262144,
  stateKeepPerTable: 200,
  debug: false,
}


/** Plugin Manager 的配置面板 schema；只声明常用字段，其余字段仍可由 patch 传入。 */
export const Config = Schema
  ? Schema.object({
      provider: Schema.string().default('spawn').description('创建 teammate 的 Agent Teams provider'),
      commanderName: Schema.string().default('commander').description('指挥员 teammate 名字，也是 send_message 的 target'),
      advisorProvider: Schema.string().default('').description('指导者模型 provider（留空沿用 Agent Teams 路由）'),
      advisorModel: Schema.string().default('').description('指导者模型 id，例如 deepseek-flash'),
      advisorReasoningEffort: Schema.string().default('').description('指导者 reasoning effort（可留空）'),
      docsDir: Schema.string().default('doc'),
      commanderTitle: Schema.string().default('指挥员').description('指挥员会话标题'),
      writeScope: Schema.string().default('doc').description('指挥员可写的相对目录；留空或 * 表示不限制'),
      goalMode: Schema.string().default('augment').description('augment / replace / off'),
      goalReminder: Schema.string().default(DEFAULT_GOAL_REMINDER),
      readOnlyTools: Schema.array(Schema.string()).default(DEFAULT_READ_ONLY_TOOLS),
      extraReadOnlyTools: Schema.array(Schema.string()).default([]),
      shellTools: Schema.array(Schema.string()).default(['pwsh', 'bash']),
      enforceApproval: Schema.boolean().default(true).description('没有「允许结束」时拒绝 complete goal'),
      resumeOnAbnormal: Schema.boolean().default(true).description('异常中断恢复会话时自动重新 arm goal'),
      maxSuggestChars: Schema.number().default(4000),
      maxPlanChars: Schema.number().default(3000),
      maxHistoryChars: Schema.number().default(4000),
      maxOrientationChars: Schema.number().default(3000),
      planSections: Schema.number().default(1),
      historySections: Schema.number().default(6),
      allowPtc: Schema.boolean().default(false),
      statePath: Schema.string().default('').description('持久化文件路径；留空用 ~/.dsh/commander/state.json'),
      expectTranscriptWindow: Schema.boolean().default(false).description('期望 UI 历史窗口已挂载；未挂载时 status 报故障'),
      locale: Schema.string().default('zh-CN').description('用户可见文案语言：zh-CN / en'),
      checkCommands: Schema.array(Schema.string())
        .default([])
        .description('受控检查命令白名单，可写 `offline = node test/offline.mjs`；commander(action=checks) 只执行这里列出的项'),
      checkTimeoutMs: Schema.number().default(180000).description('单条检查的超时毫秒数'),
      stateMaxBytes: Schema.number().default(262144).description('状态文件大小上限，超出则备份后重置'),
      stateKeepPerTable: Schema.number().default(200).description('interruptions/rounds 每张表最多保留的会话数'),
      debug: Schema.boolean().default(false),
    })
  : undefined

/**
 * 指挥工具的宿主输出 schema（自由对话 + 成员寻址）。
 */
const COMMANDER_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'text'],
  properties: {
    action: { type: 'string', enum: ['start', 'list', 'say', 'wait', 'cancel', 'goal', 'status', 'doctor', 'checks'] },
    text: { type: 'string' },
    target: { type: 'string' },
    requestId: { type: 'string' },
    kind: { type: 'string' },
    decision: { type: 'string' },
    goalAction: { type: 'string' },
    goal: { type: 'string' },
    docs: { type: 'array', items: { type: 'string' } },
    /** checks 的退出码（只有真的跑了命令才有）。 */
    exitCode: { type: 'number' },
  },
}

const RECORD_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'summary'],
  properties: {
    path: { type: 'string' },
    summary: { type: 'string' },
  },
}

/** 规整插件配置（Loader 传入的是原始 YAML 映射）。 */
function normalizeConfig(raw) {
  const config = { ...DEFAULT_CONFIG }
  if (raw === null || typeof raw !== 'object') return config
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    config[key] = value
  }
  for (const key of ['readOnlyTools', 'extraReadOnlyTools', 'shellTools', 'checkCommands']) {
    const value = config[key]
    config[key] = Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim().length > 0) : []
  }
  for (const key of ['maxSuggestChars', 'maxPlanChars', 'maxHistoryChars', 'maxOrientationChars', 'planSections', 'historySections', 'checkTimeoutMs', 'stateMaxBytes', 'stateKeepPerTable']) {
    const value = Number(config[key])
    config[key] = Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_CONFIG[key]
  }
  if (!['augment', 'replace', 'off'].includes(config.goalMode)) config.goalMode = 'augment'
  for (const key of ['provider', 'commandToolName', 'recordToolName', 'commandName', 'commanderName', 'commanderTitle', 'docsDir', 'writeScope', 'advisorProvider', 'advisorModel', 'advisorReasoningEffort']) {
    if (typeof config[key] !== 'string' || config[key].trim().length === 0) config[key] = DEFAULT_CONFIG[key]
    else config[key] = config[key].trim()
  }
  config.allowPtc = config.allowPtc === true
  config.enforceApproval = config.enforceApproval !== false
  config.resumeOnAbnormal = config.resumeOnAbnormal !== false
  config.debug = config.debug === true
  return config
}

/** 当前时间的可读文本（宿主本地时区）。 */
function nowText() {
  try {
    return new Date().toLocaleString('zh-CN', { hour12: false })
  } catch {
    return new Date().toISOString()
  }
}

/** 单行概括文本。 */
function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** 读取文件；不存在返回空字符串。 */
async function readTextSafe(file) {
  try {
    return await fsp.readFile(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return ''
    throw error
  }
}

/** 只在文件不存在时创建（不会覆盖用户内容）。 */
async function createIfMissing(file, content) {
  try {
    await fsp.writeFile(file, content, { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (error) {
    if (error && error.code === 'EEXIST') return false
    throw error
  }
}

/** 读取最新 n 个二级标题区块（最新在上），并截断。 */
function newestSections(text, maxSections, cap) {
  const value = typeof text === 'string' ? text : ''
  if (value.length === 0) return ''
  const first = value.search(/^## /m)
  if (first < 0) return value.slice(0, cap)
  const head = value.slice(0, first)
  const blocks = value.slice(first).split(/\n(?=## )/)
  return (head + blocks.slice(0, maxSections).join('\n')).slice(0, cap)
}

/** 解析 plan.md 中已有的轮次数（只统计插件写入的轮次标题）。 */
function completedRounds(planText) {
  const matches = String(planText ?? '').match(/^## 第 \d+ 轮 · /gm)
  return matches ? matches.length : 0
}

/** 在标题块之后插入一个新条目（最新在上），返回新内容。 */
function insertEntry(currentText, header, entry) {
  const current = typeof currentText === 'string' ? currentText : ''
  if (current.length === 0) return header + entry
  if (current.startsWith(header)) return header + entry + current.slice(header.length)
  const lineEnd = current.indexOf('\n\n')
  if (lineEnd >= 0) return current.slice(0, lineEnd + 2) + entry + current.slice(lineEnd + 2)
  return entry + current
}

/** 把条目倒序写入某文档（最新在上）。 */
async function prependEntry(file, header, entry) {
  const current = await readTextSafe(file)
  const next = insertEntry(current, header, entry)
  await fsp.writeFile(file, next, 'utf8')
}

/** 把指挥正文的标题降级两级，避免与插件写入的 `## 第 N 轮` 轮次标题混淆。 */
function demoteHeadings(markdown) {
  return String(markdown ?? '')
    .split('\n')
    .map((line) => line.replace(/^(#{1,4}) /, (_match, hashes) => `${'#'.repeat(Math.min(hashes.length + 2, 6))} `))
    .join('\n')
}



/** 历史条目格式。 */
function formatHistoryEntry(summary, details) {
  const head = `## ${nowText()}\n\n- ${oneLine(summary)}`
  const tail = typeof details === 'string' && details.trim().length > 0 ? `\n\n${details.trim()}` : ''
  return `${head}${tail}\n\n`
}



/** 文档根目录（会话工作目录下的 docsDir），并做越界检查。 */
function docsRoot(cwd, config) {
  const root = path.resolve(cwd, config.docsDir)
  const relative = path.relative(cwd, root)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`dsh-commander: docsDir "${config.docsDir}" 必须位于会话工作目录内`)
  }
  return root
}

/** 四份文档的绝对路径。 */
function docPaths(cwd, config) {
  const root = docsRoot(cwd, config)
  const result = {}
  for (const key of DOC_FILES) result[key] = path.join(root, `${key}.md`)
  return result
}

/** 解析会话工作目录。 */
async function resolveCwd(ctx, agent, signal) {
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory) {
    try {
      const value = workingDirectory.get?.(agent.session)
      if (typeof value === 'string' && value.length > 0) return value
    } catch {
      // 退回到 ensure / cwd
    }
    try {
      const value = await workingDirectory.ensure?.(agent, signal)
      if (typeof value === 'string' && value.length > 0) return value
    } catch {
      // 退回到 process.cwd()
    }
  }
  return process.cwd()
}

/** 创建 doc 目录与四份文档（suggest.md 只在缺失时创建，之后不再改动）。 */
async function ensureDocs(cwd, config) {
  const root = docsRoot(cwd, config)
  await fsp.mkdir(root, { recursive: true })
  const paths = docPaths(cwd, config)
  for (const key of DOC_FILES) {
    await createIfMissing(paths[key], DOC_HEADERS[key])
  }
  return paths
}

/** 读取四份文档并构造指挥所需的快照。 */
async function readDocsState(cwd, config) {
  const paths = docPaths(cwd, config)
  const suggest = await readTextSafe(paths.suggest)
  const history = await readTextSafe(paths.history)
  const plan = await readTextSafe(paths.plan)
  const agent = await readTextSafe(paths.agent)
  return {
    paths,
    round: completedRounds(plan) + 1,
    suggest,
    history,
    plan,
    agent,
    snapshot: {
      // 用户建议是自由格式，整篇注入（最新在上，截断保留最上方的新内容）。
      suggest: suggest.slice(0, config.maxSuggestChars),
      history: newestSections(history, config.historySections, config.maxHistoryChars),
      plan: newestSections(plan, config.planSections, config.maxPlanChars),
      agent: newestSections(agent, config.planSections, config.maxOrientationChars),
    },
  }
}



/** 组装指挥员 teammate 的初始提示。 */
function buildCommanderPrompt({ cwd, goal, docs, config, modelLabel, commanderId = '' }) {
  const snapshot = docs.snapshot
  const part = (title, body) => `### ${title}\n\n\`\`\`markdown\n${body.trim().length > 0 ? body.trim() : '（空）'}\n\`\`\`\n`
  return [
    '你是「指挥员」：长线项目中唯一的、长期在线的中层设计师与督察指挥官。',
    `你的身份是 Agent Teams teammate（名字 "${config.commanderName}"），Lead 会用 send_message 找你；你也可以用 send_message({ target: "lead" }) 找 Lead。你会被多轮对话复用，不要创建子agent。`,
    '',
    '## 职责与边界',
    '- 依据文档与项目事实，判断：当前完成到什么程度、项目整体目的与边界是什么、下一步具体该做什么。',
    '- **设计架构与功能铺展**：从用户意图推导完整使用流程、模块边界、数据流、扩展点与实现顺序；需求模糊时按最可能意图做功能增量（补哪些能力、用户价值、实现路径、验收方式），不要只复述或反复追问。',
    '- **完善性职责**：主动发现体验/边界/一致性缺口并给出可执行的补全建议；区分必须补全项与可选后续，不无限扩大范围。',
    '- 你可以读**整个工作区**（不只 doc/）：read / glob / grep / read_image 都能用；文件沙箱不限制你读取工作区外的路径。`doc/` 只是摘要与计划，**权威事实以仓库真实文件为准**。',
    '- 你可以运行**只读 shell**（若工具可用）：只允许查看类命令（git status/log/diff、rg、Get-ChildItem、Get-Content、Select-String 等）；写文件、改仓库、编译/构建、下载与解释器命令都会被拦截。',
    '- 你有写文件（write / edit）权限，但**默认不要动手**：实现、改代码、跑改动都交给工程组；只有维护 doc/plan.md、doc/agent.md 这类指挥留痕时才写，写完立刻回到指挥判断，不要因写文件分散注意力。',
    '- **大多数问题自己决定**：依据 doc/suggest.md 与用户已有需求做取舍，保留最大建议/决策空间；不要等用户逐条确认，也不要用提问代替判断。只有真正会改变用户需求/产品语义且无法判断的事项，才用 `send_message({ target: "lead" })` 说明取舍与推荐供 Lead 决策。',
    '- 你是长期在线的指挥循环，会被多轮询问：善用上下文记忆，不必重复已完成的大范围核对。',
    '- **工程组 / Agent Teams / 其他子agent 才是执行主体**：下一步建议必须写清每条交给谁（哪个工程组、哪个子agent、还是主agent），不要把全部工作都压给主agent自己。',
    '- 不要建议「暂停 goal」「等用户确认」「等指令」或「先停下」，除非用户明确要求；有不确定就给出可执行推荐方案。',
    '',
    '## 本轮输入',
    `- 项目根目录：${cwd}`,
    `- 你的会话 id：${commanderId || '（由宿主分配）'}`,
    `- 当前指挥轮次：第 ${docs.round} 轮`,
    `- 本轮时间：${nowText()}`,
    `- 会话 goal（只读，你不能修改它）：${goal && goal.objective ? goal.objective : '（当前会话没有 goal）'}`,
    `- 宿主为指挥员选择的模型：${modelLabel}`,
    '',
    '## 文档快照（摘要，可能过时；权威事实请直接读仓库文件）',
    `文档路径：${Object.values(docs.paths).map((file) => `\`${file}\``).join('、')}`,
    '',
    part('doc/suggest.md（用户建议板：仅用户编写，每轮必读，优先级最高）', snapshot.suggest),
    part('doc/agent.md（设计导向：编辑行为分化与设计方向）', snapshot.agent),
    part('doc/plan.md（当前计划：最新一轮）', snapshot.plan),
    part('doc/history.md（主agent行动历史：最新若干条）', snapshot.history),
    '## 侦察要求',
    '1. 先用 glob / grep / read 核对项目真实状态：计划中的步骤是否完成、关键文件是否存在、测试/构建是否可验证。',
    '2. history 与 plan 可能过时或与现状冲突；以仓库事实为准，并指出偏差。',
    '3. 如果 doc/suggest.md 的建议与历史计划冲突，以用户建议为最高优先级调整建议。',
    '4. 不要臆测未检查的结论；无法证实的部分明确标注「未验证」。',
    '5. 你会在同一会话中被反复询问：善用上下文里的历史，不重复已完成的大范围核对。',
    '',
    '## 输出要求（自由对话）',
    '- 直接回答，用 Markdown；不要输出 JSON 结论块。',
    '- **大多数问题自己决定**：依据 doc/suggest.md 与用户原始需求做取舍，不要等 Lead 或用户逐条确认。',
    '- 只有真正会改变用户需求或产品语义、且无法从现有材料判断的事项，才用 `send_message({ target: "lead" })` 说明取舍与推荐，让 Lead 决策；不要用提问代替判断。',
    '- 回答要具体、可执行；不要重复已经核对过的事实，除非 Lead 要求。',
    '',
    '## 指挥员契约',
    COMMANDER_CONTRACT,
  ].join('\n')
}













/** 只读 shell 白名单：按命令首 token 判定，避免路径里出现 npm/node 就被误杀。 */
const READ_ONLY_COMMANDS = new Set([
  // Unix 侧的基础读取/查看命令（只有 rg 没有 grep 是漏的，指挥员真撞上过）
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'which',
  'where',
  'column',
  'od',
  'xxd',
  'hostname',
  'true',
  'false',
  'get-content',
  'get-childitem',
  'get-item',
  'get-itemproperty',
  'select-string',
  'select-object',
  'where-object',
  'measure-object',
  'sort-object',
  'format-table',
  'format-list',
  'get-location',
  'test-path',
  'resolve-path',
  'split-path',
  'join-path',
  'write-output',
  'write-host',
  'get-command',
  'get-help',
  'get-member',
  'rg',
  'ls',
  'dir',
  'tree',
  'cat',
  'type',
  'head',
  'tail',
  'wc',
  'findstr',
  'more',
  'echo',
  // 校验/元数据/文本处理：指挥员要能独立复算指纹与时间，才谈得上督察。
  'sha256sum',
  'shasum',
  'md5sum',
  'get-filehash',
  'stat',
  'file',
  'date',
  'get-date',
  'du',
  'df',
  'uname',
  'whoami',
  'pwd',
  'printenv',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'find',
  'diff',
  'cmp',
  'sort',
  'uniq',
  'cut',
  'tr',
  'nl',
  'jq',
  'sed',
  'awk',
])

const READ_ONLY_GIT = new Set([
  'status',
  'log',
  'diff',
  'show',
  'branch',
  'remote',
  'rev-parse',
  'ls-files',
  'grep',
  'blame',
  'describe',
  'show-ref',
  'tag',
])

/** git 全局参数：带值的需要吞掉下一个 token，否则会把参数误当成子命令。 */
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path'])
/** git 全局布尔参数。 */
const GIT_BOOL_FLAGS = new Set(['--no-pager', '-p', '--paginate', '--no-replace-objects', '--literal-pathspecs', '--bare'])

/** 取 git 子命令：跳过 `-C <path>` / `-c k=v` / `--no-pager` 等全局参数。 */
function gitSubcommand(tokens) {
  let index = 1
  while (index < tokens.length) {
    const token = String(tokens[index]).replace(/^['"]|['"]$/g, '')
    if (GIT_VALUE_FLAGS.has(token)) {
      index += 2
      continue
    }
    if (GIT_BOOL_FLAGS.has(token)) {
      index += 1
      continue
    }
    if (token.startsWith('-')) return { error: `git 全局参数 ${token} 不在只读白名单` }
    return { sub: token.toLowerCase() }
  }
  return { sub: '' }
}

/**
 * 按引号外的分隔符把命令行切成若干「独立命令」。
 *
 * 分隔符：换行、`;`、`&&`、`||`、`|`。引号内的这些字符是数据
 * （例如 `Select-String -Pattern 'a|b'`），不切段。
 */
function splitUnquotedCommands(text) {
  const source = String(text ?? '')
  const segments = []
  let current = ''
  let quote
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      current += char
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '\n' || char === '\r' || char === ';') {
      segments.push(current)
      current = ''
      continue
    }
    if (char === '&' && source[index + 1] === '&') {
      segments.push(current)
      current = ''
      index += 1
      continue
    }
    if (char === '|') {
      segments.push(current)
      current = ''
      // `||` 是两个字符的分隔符，吃掉第二个
      if (source[index + 1] === '|') index += 1
      continue
    }
    current += char
  }
  segments.push(current)
  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0)
}

/**
 * 找出「引号外、且会写文件」的输出重定向。
 *
 * 返回命中的片段（如 `> out.txt`），没有则返回 undefined。
 * 不算写文件的三种情况：引号内的 `>`（格式化字符串里的尖括号）、
 * 文件描述符复制（`2>&1` / `1>&2`）、指向空设备（`>$null` / `>/dev/null`）。
 */
function unquotedFileRedirect(text) {
  const source = String(text ?? '')
  let quote
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char !== '>') continue
    const rest = source.slice(index + 1)
    // 2>&1 / 1>&2：复制文件描述符，不写文件
    if (/^\d*&\d/.test(rest)) continue
    // >$null / >/dev/null：丢弃输出，不写文件
    if (/^\d*\s*(?:\$null\b|\/dev\/null\b)/i.test(rest)) continue
    return source.slice(index, index + 24).trim()
  }
  return undefined
}

/** 只读 shell 的保守拦截：命令必须落在白名单内，禁止重定向/子表达式。 */
function readOnlyShellViolation(command) {
  const text = String(command ?? '')
  if (text.trim().length === 0) return '空命令'
  if (/\$\(|`/.test(text)) return '包含子表达式/反引号'
  // 只认「引号外、且真的写文件」的重定向：`--format='%h %an <%ae>'` 里的 > 是数据，
  // `2>&1` 是文件描述符复制，`>$null` / `>/dev/null` 不落盘，都不算写操作。
  const redirect = unquotedFileRedirect(text)
  if (redirect) return `包含输出重定向（${redirect}）`
  const segments = splitUnquotedCommands(text)
  for (const segment of segments) {
    const tokens = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
    let first = String(tokens[0] ?? '').replace(/^['"]|['"]$/g, '')
    first = first.replace(/^&\s*/, '')
    first = first.split(/[\\/]/).pop() ?? first
    first = first.replace(/\.exe$/i, '').toLowerCase()
    if (first.length === 0) continue
    if (first === 'git') {
      const { sub, error } = gitSubcommand(tokens)
      if (error) return error
      if (!READ_ONLY_GIT.has(sub)) return `git ${sub || '（缺少子命令）'} 不在只读白名单`
      continue
    }
    if (!READ_ONLY_COMMANDS.has(first)) return `命令 "${first}" 不在只读白名单`
    // sed -i / --in-place 会原地写文件；awk 的 system() 能执行任意命令。
    if (first === 'sed' && tokens.some((token) => /^-i|^--in-place/.test(String(token)))) {
      return 'sed 的 -i/--in-place 会写文件，不在只读白名单'
    }
    if (first === 'awk' && /system\s*\(|getline/.test(segment)) {
      return 'awk 的 system()/getline 不在只读白名单'
    }
  }
  return undefined
}

/** 把宿主返回的消息 id（字符串或带 id 的对象）格式化成可读文本。 */
function formatMessageId(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    for (const key of ['id', 'messageId', 'value']) {
      if (typeof value[key] === 'string') return value[key]
    }
  }
  return 'accepted'
}

/** 安装插件。 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)

  /** 用户可见文案：zh-CN 全量、en 兜底；缺 key 显式告警。 */
  const t = createTranslator(config.locale, {
    onMissing: (key) => ctx.logger?.warn?.(`dsh-commander: 缺少文案 key "${key}"`),
  })

  /**
   * 进程启动时刻（不是插件加载时刻）。
   *
   * 用 `process.uptime()` 反推，所以插件重载不会把它刷新 —— 重载后仍在跑的
   * teammate 回合不会被误判成「上个进程遗留」。只有当真的重启过进程，
   * `pending.sentAt` 才会早于它。
   */
  const PROCESS_START = Date.now() - Math.round(process.uptime() * 1000)

  /** pending 是否是上个进程遗留的（那种请求的回复永远不会再来了）。 */
  function isStalePending(pending) {
    if (!pending) return false
    const sentAt = Number(pending.sentAt ?? 0)
    if (!Number.isFinite(sentAt) || sentAt <= 0) return false
    return sentAt < PROCESS_START - 1000
  }

  if (config.commandToolName === config.recordToolName) {
    throw new Error('dsh-commander: commandToolName 与 recordToolName 不能相同')
  }

  /** 正在运行的指挥员会话 id。 */
  const commanderIds = new Set()
  /** 已启动指挥员的 Lead 会话（用于放行门禁作用域）。 */
  const commanderStarted = new Set()
  /** 已同步过契约的 teammate 会话。 */
  const contractSynced = new Set()
  /** 每个 Lead 会话当前有效的「允许结束」放行。 */
  const approvedSessions = new Map()
  /** 当前用户回合内是否已经咨询过指挥员。 */
  const consultedSinceUser = new Map()
  /** 每个 Lead 会话的接管状态（只在内存里：启动时初始化，不跨进程沿用）。 */
  const takeoverOverrides = new Map()
  /** 每个 Lead 会话由指挥员批准的 goal 变更动作（一次性）。 */
  const goalApprovals = new Map()
  /** 最近一次插件执行的 goal 操作，用于判断 pause/resume 来源是 agent 还是 user。 */
  const goalOperationMarkers = new Map()
  /** 指挥员可执行工具集合（执行期 guard 使用）。 */
  const allowedByAgent = new Map()
  /** 每个指挥员作用域限制的 disposer。 */
  const restrictionDisposers = new Map()

  /** 指挥员只在主会话里使用；子agent/teammate 不应该再套一个指挥循环。 */
  function assertRootAgent(agent) {
    if (agent?.session?.header?.parentSession) {
      throw new Error('dsh-commander: 指挥员只能在主会话中使用；子agent/teammate 请直接使用工程组协作，不要创建第二层指挥循环。')
    }
  }

  /** 列出当前主会话下所有可续接的指挥员子agent（含历史遗留的 commander-<uuid>）。 */
  async function listCommanderChildren(agent, signal) {
    const sub = ctx.subagents
    if (typeof sub.listChildren !== 'function') return []
    const parentId = agent?.session?.header?.id ?? agent?.id
    let rows = []
    try {
      rows = await sub.listChildren(parentId, signal)
    } catch {
      return []
    }
    return (Array.isArray(rows) ? rows : [])
      .filter((row) => row && row.mode === 'continuable')
      .filter((row) => {
        const label = String(row.label ?? '')
        const id = String(row.id ?? '')
        return label === '指挥员' || label.startsWith('指挥') || id.startsWith('commander-')
      })
      .map((row) => ({
        id: String(row.id),
        label: String(row.label ?? '指挥员'),
        createdAt: typeof row.createdAt === 'number' ? row.createdAt : 0,
      }))
      .sort((left, right) => right.createdAt - left.createdAt)
  }

  

  

  /** 指挥员的工具拒绝理由。 */
  const denyReason = (toolName) => t('gate.commanderReadOnly', { tool: toolName })

  /** goal 当前阶段；读不到时返回 undefined（不阻断）。 */
  function currentGoalPhase(agent) {
    try {
      return ctx.get('goals')?.get?.(agent)?.phase
    } catch {
      return undefined
    }
  }

  /** 当前任务（goal 目标），作为交接汇报的进度锚点；没有 goal 就空。 */
  function currentGoalObjective(agent) {
    try {
      const goal = ctx.get('goals')?.get?.(agent)
      return typeof goal?.objective === 'string' ? goal.objective : ''
    } catch {
      return ''
    }
  }

  /** 指挥员 teammate 是否已经存在（同步，供门禁使用）。 */
  function commanderExists(agent) {
    try {
      const members = teamService().listMembers(agent)
      return (Array.isArray(members) ? members : []).some(
        (member) => member.role === 'teammate' && member.name === config.commanderName,
      )
    } catch {
      return commanderStarted.size > 0
    }
  }

  /**
   * 当前接管状态（同步读内存缓存，门禁可以直接用）。
   *
   * 没有指挥员=off；有指挥员=显式设定值，没设过就是启动默认值 partial。
   * 不再看 goal：接管宽度由你显式选择，不跟着 goal 起落。
   */
  function currentTakeover(agent) {
    const leadId = rootSessionIdOf(agent)
    const record = takeoverOverrides.get(leadId)
    return resolveTakeover({
      hasCommander: commanderExists(agent),
      override: record?.state,
      overrideSource: record?.source,
    })
  }

  /**
   * goal 动作门禁（`update_goal` 的 guard 与 `commander(action="goal")` 共用）。
   *
   * 两边必须走同一套判定：否则主agent 绕道 `commander(goal, complete)` 就能跳过批准，
   * 门禁等于没有。
   *
   * @returns {string|undefined} 拒绝原因；undefined 表示放行
   */
  function goalGateError(agent, action, options = {}) {
    if (config.enforceApproval !== true) return undefined
    const header = agent.session?.header
    if (header?.parentSession) return undefined
    const leadId = rootSessionIdOf(agent)
    if (!commanderStarted.has(leadId)) return undefined
    // partial/full 才接管 goal 命令；observe/off 下不拦。
    if (!requiresGoalApproval(currentTakeover(agent).state)) return undefined
    const allowed = goalApprovals.get(leadId)
    const phase = currentGoalPhase(agent)
    if (action === 'complete') {
      // 已经是 complete：插件/wait 可能已替 Lead 执行，幂等放行。
      if (approvedSessions.has(leadId) || phase === 'complete') return undefined
      return t('gate.needRelease')
    }
    if (action === 'resume') return t('gate.resumeByUser')
    if (action === 'edit' || action === 'pause' || action === 'blocked') {
      if (allowed?.has(action)) {
        if (options.consume !== false) allowed.delete(action)
        return undefined
      }
      // goal 已经处于目标态：说明 wait 处理批准时插件已执行过，不要再报“需要批准”。
      const targetPhase = action === 'blocked' ? 'blocked' : action === 'pause' ? 'paused' : undefined
      if (targetPhase !== undefined && phase === targetPhase) return undefined
      return phase ? t('gate.needApprovalPhase', { action, phase }) : t('gate.needApproval', { action })
    }
    return undefined
  }

  // 放行门禁：写工具使当前放行失效；没有「允许结束」时不允许 complete goal。
  ctx.effect(() =>
    ctx.tools.guard((exec) => {
      const agent = exec.agent
      if (!agent) return undefined
      const header = agent.session?.header
      const leadId = rootSessionIdOf(agent)
      const isWriteTool = exec.name === 'write' || exec.name === 'edit' || exec.name === 'apply_patch'
      const isShell = config.shellTools.includes(exec.name)
      const shellCommand = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments.command : ''
      const shellMutates = isShell && readOnlyShellViolation(typeof shellCommand === 'string' ? shellCommand : '') !== undefined
      if (isWriteTool || shellMutates) {
        approvedSessions.delete(leadId)
      }
      // 全接管下连 subagent 也不能直接问用户：它拿不到 commander 工具（只有根 agent 能咨询），
      // 让它问就等于开了一个绕过指挥员的后门。
      if (exec.name === 'ask_user_question') {
        // 只有「全接管」才强制先咨询：partial/observe/off 下问用户不该被拦。
        const takeover = currentTakeover(agent)
        if (requiresConsultBeforeAsking(takeover.state) && consultedSinceUser.get(leadId) !== true) {
          return t('gate.needCommander')
        }
      }
      if (exec.name !== 'update_goal') return undefined
      const action = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments.action : undefined
      return goalGateError(agent, action)
    }),
  )

  ctx.effect(() =>
    ctx.tools.guard((exec) => {
      const agent = exec.agent
      if (!agent) return undefined
      const allowed = allowedByAgent.get(agent.id)
      if (allowed === undefined) {
        if (!commanderIds.has(agent.id)) return undefined
        return denyReason(exec.name)
      }
      if (!allowed.has(exec.name)) return denyReason(exec.name)
      if (exec.name === 'write' || exec.name === 'edit' || exec.name === 'apply_patch') {
        const scopeVerdict = writeScopeViolation(agent, exec)
        if (scopeVerdict !== undefined) return scopeVerdict
      }
      if (config.shellTools.includes(exec.name)) {
        const command = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments.command : ''
        const verdict = readOnlyShellViolation(typeof command === 'string' ? command : '')
        if (verdict !== undefined) return `指挥员只能执行只读命令：${verdict}`
      }
      return undefined
    }),
  )

  /** 收紧指挥员（teammate 或历史子agent）的工具面。 */
  function applyCommanderRestriction(agent) {
    if (!commanderIds.has(agent.id)) {
      try {
        const membership = ctx.get('agentTeams')?.membership?.(agent)
        if (membership?.role === 'teammate' && membership.name === config.commanderName) commanderIds.add(agent.id)
      } catch {
        // 非 Team 成员
      }
    }
    if (!commanderIds.has(agent.id)) return
    if (allowedByAgent.has(agent.id)) return
    const available = config.readOnlyTools.filter((toolName) => {
      try {
        return agent.ctx.tools.get(toolName, agent) !== undefined
      } catch {
        return false
      }
    })
    for (const toolName of [...config.extraReadOnlyTools, ...config.shellTools, 'send_message', 'list_agents']) {
      if (available.includes(toolName)) continue
      try {
        if (agent.ctx.tools.get(toolName, agent) !== undefined) available.push(toolName)
      } catch {
        // 忽略不可用工具
      }
    }
    if (available.length === 0) {
      throw new Error(
        'dsh-commander: 指挥员看不到任何只读工具，已拒绝创建。请确认当前 preset 挂载了 tool-fs / tool-fs-search，或在插件配置 readOnlyTools 中指定实际工具名。',
      )
    }
    const allow = [...new Set(available)]
    // PTC 呈现模式下代码内可以直接产生副作用，无法保证「只读」边界；
    // 默认拒绝创建，除非用户显式接受该风险。
    let ptcVisible = false
    try {
      ptcVisible = agent.ctx.tools.get(PTC_TRANSPORT, agent) !== undefined
    } catch {
      ptcVisible = false
    }
    if (ptcVisible && config.allowPtc !== true) {
      throw new Error(
        'dsh-commander: 指挥员继承了 PTC 工具呈现模式（run_code），无法保证「只读、不改文件」的边界。请改用 native 工具呈现的 agent preset，或在插件配置中设置 allowPtc: true 并自行承担该风险。',
      )
    }
    const dispose = agent.ctx.tools.restrict({ allow })
    restrictionDisposers.set(agent.id, dispose)
    const executable = new Set(allow)
    if (ptcVisible) executable.add(PTC_TRANSPORT)
    allowedByAgent.set(agent.id, executable)
    if (config.debug) {
      ctx.logger?.info?.(`dsh-commander: commander ${agent.id} restricted to ${allow.join(', ')}`)
    }
  }

  // 指挥员创建时收紧它的工具面。
  ctx.on('agent/created', ({ agent }) => {
    applyCommanderRestriction(agent)
    if (!agent?.session?.header?.parentSession) {
      hydrateApproval(agent).catch(() => {})
      resumeAfterAbnormal(agent).catch(() => {})
    }
  })

  // 插件重载时旧的 restrict 已随旧作用域释放：给仍存活的指挥员重新收紧。
  try {
    for (const agent of ctx.get('agents')?.list?.() ?? []) applyCommanderRestriction(agent)
  } catch {
    // 没有 agents 服务时忽略
  }
  // 重载后恢复“该会话已启动指挥员”的门禁作用域。
  try {
    for (const root of ctx.get('agents')?.roots?.() ?? []) {
      let members = []
      try {
        members = ctx.get('agentTeams')?.listMembers?.(root) ?? []
      } catch {
        members = []
      }
      if (members.some((member) => member.name === config.commanderName)) commanderStarted.add(root.id)
      hydrateApproval(root).catch(() => {})
      resumeAfterAbnormal(root).catch(() => {})
    }
  } catch {
    // 忽略
  }

  ctx.on('agent/disposed', ({ agent }) => {
    if (!commanderIds.has(agent.id) && !allowedByAgent.has(agent.id)) return
    commanderIds.delete(agent.id)
    allowedByAgent.delete(agent.id)
    const dispose = restrictionDisposers.get(agent.id)
    restrictionDisposers.delete(agent.id)
    if (dispose) {
      try {
        dispose()
      } catch {
        // 作用域销毁时可能已释放
      }
    }
  })

  // complete 前异步校验代码状态：外部改动会让放行失效，而不是只在 status 里显示。
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!exec?.agent || exec.name !== 'update_goal') return next()
    if (config.enforceApproval !== true) return next()
    const action = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments.action : undefined
    if (action !== 'complete') return next()
    const header = exec.agent.session?.header
    if (header?.parentSession) return next()
    const leadId = header?.id ?? exec.agent.id
    if (!commanderStarted.has(leadId)) return next()
    const approval = approvedSessions.get(leadId)
    if (!approval) return next()
    let cwd = ''
    try {
      cwd = ctx.get('workingDirectory')?.get?.(exec.agent.session) ?? ''
    } catch {
      cwd = ''
    }
    if (!cwd) return next()
    const current = await computeCodeState(cwd).catch(() => undefined)
    if (!current || current === approval.codeState) return next()
    approvedSessions.delete(leadId)
    await clearApproval(leadId).catch(() => {})
    return {
      kind: 'deny',
      reason: `指挥员放行已失效：代码状态在放行后发生变化（放行 ${approval.codeState}，当前 ${current}）。请重新汇报并取得「允许结束」。`,
    }
  })

  // 记录根会话的 turn/end：用户主动中断算正常中断，其余异常中断留待恢复。
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    // 先缓存指挥员回复到 pending，保证 wait 被中断后仍能在下一次 wait 取回。
    for (const [leadId, pending] of memoryPending) {
      if (pending.commanderId !== session?.id) continue
      try {
        const text = lastAssistantText(session, pending.baselineSeq, pending.sentAt)
        if (text.length > 0 && parseRequestId(text) === pending.requestId) {
          savePending(leadId, { ...pending, lastReply: { text, at: Date.now() } }).catch(() => {})
        }
      } catch {
        // 忽略
      }
    }
    if (!session?.header || session.header.parentSession) return
    const reason = event.data?.reason
    const kind = reason?.kind
    const normal =
      kind === 'completed' ||
      kind === 'forked' ||
      kind === 'interrupted' ||
      (kind === 'aborted' && reason?.reason?.kind === 'user')
    const abnormal = !normal
    const source =
      abnormal ? 'abnormal' : kind === 'aborted' && reason?.reason?.kind === 'user' ? 'user' : 'completed'
    mergeInterruption(session.id, {
      abnormal,
      source,
      ...(source === 'user' ? { goalSource: 'user' } : source === 'abnormal' ? { goalSource: 'abnormal' } : {}),
      kind,
      cause: reason?.reason?.kind,
      at: typeof event.time === 'number' ? event.time : Date.now(),
    }).catch(() => {})
  })

  // 用户新消息开始新一轮：重置“已咨询指挥员”，强制先问指挥员。
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'user/message') return
    if (!session?.header || session.header.parentSession) return
    // 只认真实用户消息。合成消息（agent-message、runtime-context 等）不是用户发言，
    // 不该把门禁清零；source 缺失时按用户处理，避免门禁永远打不开。
    const kind = event.data?.source?.kind
    if (kind !== undefined && kind !== 'user') return
    consultedSinceUser.set(session.id, false)
    // 接管状态不再因为你发言而降级：硬控制权在用户手里（图标菜单），
    // 你插话不代表你要放弃全接管。
  })

  // 记录 goal 生命周期变更来源：插件执行=agent，用户界面=user。
  ctx.on('goal/changed', ({ agent, change }) => {
    if (!agent?.id || !change?.operation) return
    const operation = change.operation
    if (!['pause', 'resume', 'complete', 'block', 'clear'].includes(operation)) return
    const marker = goalOperationMarkers.get(agent.id)
    // 标记存在即表示这次变更是插件（agent）刚发起的；用后删除。不用时间窗。
    const fromAgent = Boolean(marker && operation !== 'clear' && marker.action === operation)
    if (marker) goalOperationMarkers.delete(agent.id)
    mergeInterruption(agent.id, {
      goalSource: fromAgent ? 'agent' : 'user',
      goalAction: operation,
      goalAt: Date.now(),
    }).catch(() => {})
  })

  // 插件卸载时释放仍存活的作用域限制。
  ctx.effect(() => () => {
    for (const dispose of restrictionDisposers.values()) {
      try {
        dispose()
      } catch {
        // 忽略重复释放
      }
    }
    restrictionDisposers.clear()
    allowedByAgent.clear()
    commanderIds.clear()
    if (pendingUnitPromise !== undefined) {
      pendingUnitPromise.then((unit) => unit?.close?.()).catch(() => {})
    }
  })

  /** 调用者是否是运行时顶层会话（用户会话）。 */
  function isRuntimeRoot(agent) {
    try {
      const agents = ctx.get('agents')
      if (!agents || typeof agents.roots !== 'function') return true
      return agents.roots().includes(agent)
    } catch {
      return true
    }
  }

  /**
   * 开启 goal 模式：只在会话**没有** goal 时创建一次。
   * start/say 不改动已有 goal；goal 的 edit/pause/blocked 需要指挥员
   * 单独批准（「批准：goal <动作>」），异常中断恢复时会自动 rearm active goal。
   */
  async function applyGoalPolicy(agent, options = {}) {
    if (config.goalMode === 'off') return ''
    // goal 续跑只对顶层会话有意义；子会话（subagent/teammate）在父级释放后不存在。
    if (!isRuntimeRoot(agent)) {
      return '（当前是子agent会话：不开启 goal 续跑；协作提醒仅在用户主会话中生效）'
    }
    const goals = ctx.get('goals')
    if (!goals || typeof goals.create !== 'function') {
      return '（goal 服务不可用，未开启 goal 模式）'
    }
    let current
    try {
      current = goals.get(agent)
    } catch (error) {
      return `（读取 goal 失败，未改动 goal：${error && error.message ? error.message : String(error)}）`
    }
    if (current !== undefined) {
      // 已有 goal（任意 phase）都保持原样：不改 objective、不 resume、不 pause。
      return `goal 已存在（phase=${current.phase}），保持原样未改动`
    }
    const reminder = String(config.goalReminder || DEFAULT_GOAL_REMINDER).trim()
    const firstAction = options.commandStart
      ? '\n\n第一件事：调用 commander（action=round）获取本轮指挥结论，再按建议开始执行。'
      : ''
    goals.create(agent, { objective: `${reminder}${firstAction}` })
    return `已开启 goal 模式：${GOAL_MARKER} 协作目标已创建`
  }

  

  

  

  

  

  

  /** 取 Agent Teams 服务；缺失时给出明确错误。 */
  function teamService() {
    const team = ctx.get('agentTeams')
    if (!team || typeof team.spawnTeammate !== 'function') {
      throw new Error('dsh-commander: 当前 profile 没有 Agent Teams 服务；请启用 agent-team profile 后再用指挥员。')
    }
    return team
  }

  /** 沿 parentSession 链上溯到根会话；取不到父会话时停在最后一个已知 id。 */
  function rootSessionIdOf(agent) {
    let header = agent?.session?.header
    let id = header?.id ?? agent?.id
    let depth = 0
    while (header?.parentSession && depth < 32) {
      id = header.parentSession
      let parent
      try {
        parent = ctx.get('sessions')?.get?.(header.parentSession)
      } catch {
        parent = undefined
      }
      if (!parent) break
      header = parent.header
      depth += 1
    }
    return id
  }

  /** 指挥员的写作用域：默认只允许写 doc/，避免“写权限”扩散到代码。 */
  function writeScopeViolation(agent, exec) {
    if (!commanderIds.has(agent.id)) return undefined
    const scopeConfig = config.writeScope
    if (!scopeConfig || scopeConfig === '*' || scopeConfig === 'off') return undefined
    let cwd = ''
    try {
      cwd = ctx.get('workingDirectory')?.get?.(agent.session) ?? ''
    } catch {
      cwd = ''
    }
    if (!cwd) cwd = process.cwd()
    const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {}
    const raw = args.file_path ?? args.filePath ?? args.path
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      return `写权限仅限 ${scopeConfig}/：缺少目标路径，无法确认范围`
    }
    const target = resolve(cwd, raw)
    const scope = resolve(cwd, scopeConfig)
    if (target === scope || target.startsWith(scope + sep)) return undefined
    return `写权限仅限 ${scopeConfig}/：禁止写 ${raw}`
  }

  /** 异常中断后恢复：仅对根会话、active 且被 disarmed 的 goal 重新 arm。 */
  async function resumeAfterAbnormal(agent) {
    if (!agent?.session?.header || agent.session.header.parentSession) return
    if (config.resumeOnAbnormal === false) return
    const record = await loadInterruption(agent.id)
    if (!record) return
    const source = record.goalSource ?? record.source
    // 用户主动暂停不自动恢复；只有 agent 自己停或异常中断才自动续。
    if (source === 'user') return
    if (!record.abnormal && source !== 'agent') return
    const goals = ctx.get('goals')
    let goal
    try {
      goal = goals?.get?.(agent)
    } catch {
      goal = undefined
    }
    if (!goal || goal.phase === 'complete') return
    const needsResume = goal.phase === 'paused' || (goal.phase === 'active' && goal.activation === 'disarmed')
    if (!needsResume) return
    try {
      await applyGoalOperation(agent, 'resume')
      await mergeInterruption(agent.id, { abnormal: false, source: 'agent', goalSource: 'agent', resumedAt: Date.now() })
      ctx.logger?.info?.(`dsh-commander: 恢复 goal ${goal.id}（source=${source}）`)
    } catch (error) {
      const message = error?.message ?? String(error)
      if (/human|model cannot resume|direct human turn/i.test(message)) {
        await mergeInterruption(agent.id, { abnormal: false, requiresUserResume: true }).catch(() => {})
        ctx.logger?.warn?.(`dsh-commander: goal 恢复被宿主拒绝，需要用户在界面恢复：${message}`)
      } else {
        ctx.logger?.warn?.(`dsh-commander: failed to resume goal after interruption: ${message}`)
      }
    }
  }

  /** 由 Host 直接管理 goal（绕开 update_goal 的模型限制，仅用于受控动作）。 */
  async function applyGoalOperation(agent, action, options = {}) {
    const goals = ctx.get('goals')
    if (!goals) throw new Error('goals 服务不可用')
    if (['pause', 'resume', 'complete', 'blocked'].includes(action)) {
      // 只记「即将由插件执行」这一个事实；goal/changed 里按标记存在与否归因，
      // 不用时间窗（慢盘/排队会把 agent 发起误判成 user）。
      goalOperationMarkers.set(agent.id, { action: action === 'blocked' ? 'block' : action, at: Date.now() })
      // 万一事件没到达，60 秒后自然过期，避免陈旧标记把用户操作误判成 agent。
      const timer = setTimeout(() => {
        const current = goalOperationMarkers.get(agent.id)
        if (current && Date.now() - current.at >= 60_000) goalOperationMarkers.delete(agent.id)
      }, 60_000)
      timer.unref?.()
    }
    let goal = goals.get(agent)
    if (action === 'create') {
      if (goal && goal.phase !== 'complete') {
        throw new Error(`当前 goal 处于 ${goal.phase}，不能直接 create；先 complete 或 clear。`)
      }
      const objective = typeof options.objective === 'string' ? options.objective.trim() : ''
      if (!objective) throw new Error('goal create 需要 objective')
      const created = goals.create(agent, {
        objective,
        ...(Number.isSafeInteger(options.maxRounds) && options.maxRounds > 0 ? { maxGoalRounds: options.maxRounds } : {}),
      })
      return { goal: created }
    }
    if (!goal) throw new Error('当前没有 goal')
    const ref = { id: goal.id, revision: goal.revision }
    if (action === 'edit') {
      const request = {}
      if (typeof options.objective === 'string' && options.objective.trim().length > 0) request.objective = options.objective.trim()
      if (Number.isSafeInteger(options.maxRounds) && options.maxRounds > 0) request.maxGoalRounds = options.maxRounds
      if (Object.keys(request).length === 0) throw new Error('goal edit 需要 objective 或 maxRounds')
      return { goal: goals.edit(agent, ref, request) }
    }
    if (action === 'pause') return { goal: goals.pause(agent, ref) }
    if (action === 'resume') return { goal: goals.resume(agent, ref) }
    if (action === 'complete') return { goal: goals.complete(agent, ref) }
    if (action === 'blocked') {
      return { goal: goals.block(agent, ref, { code: 'commander', message: options.reason ?? '指挥员标记 blocked' }) }
    }
    if (action === 'clear') return { goal: goals.clear(agent, ref) }
    throw new Error(`未知 goal 动作 ${action}`)
  }
  async function applyCommanderTitle(sessionId) {
    const title = config.commanderTitle
    if (!title) return undefined
    const controller = ctx.get('sessionController')
    if (!controller || typeof controller.rename !== 'function') return { error: 'sessionController 不可用' }
    try {
      await controller.rename({ sessionId, title })
      return { title }
    } catch (error) {
      return { error: error && error.message ? error.message : String(error) }
    }
  }

  /** 按插件配置给指挥员会话选定模型（Plugin Manager 的 advisorProvider/advisorModel）。 */
  async function applyAdvisorModel(sessionId) {
    const provider = config.advisorProvider
    const model = config.advisorModel
    if (!provider || !model) return undefined
    const controller = ctx.get('sessionController')
    if (!controller || typeof controller.selectModel !== 'function') {
      return { error: 'sessionController 不可用，无法设置指导者模型' }
    }
    try {
      const result = await controller.selectModel({
        sessionId,
        provider,
        model,
        ...(config.advisorReasoningEffort ? { reasoningEffort: config.advisorReasoningEffort } : {}),
      })
      return { selected: result?.selected ?? { provider, model } }
    } catch (error) {
      // 刚创建的 teammate 可能还在 provisioning：短暂等待后重试一次。
      try {
        await new Promise((resolve) => setTimeout(resolve, 800))
        const result = await controller.selectModel({
          sessionId,
          provider,
          model,
          ...(config.advisorReasoningEffort ? { reasoningEffort: config.advisorReasoningEffort } : {}),
        })
        return { selected: result?.selected ?? { provider, model } }
      } catch (retryError) {
        return { error: retryError && retryError.message ? retryError.message : String(retryError) }
      }
    }
  }

  /** 确保存在唯一名为 commanderName 的 teammate；已有则直接接管。 */
  async function ensureCommanderTeammate(agent, cwd, docs, goal, signal) {
    const team = teamService()
    let members = []
    try {
      members = team.listMembers(agent)
    } catch {
      members = []
    }
    const existing = (Array.isArray(members) ? members : []).find(
      (member) => member.role === 'teammate' && member.name === config.commanderName,
    )
    if (existing) {
      commanderStarted.add(agent.session?.header?.id ?? agent.id)
      if (!contractSynced.has(existing.id)) {
        contractSynced.add(existing.id)
        try {
          await team.sendMessage(agent, {
            target: existing.name,
            content: [{ type: 'text', text: `[契约同步]\n${COMMANDER_CONTRACT}` }],
            signal,
          })
        } catch {
          contractSynced.delete(existing.id)
        }
      }
      try {
        const live = ctx.get('agents')?.get?.(existing.id)
        if (live) applyCommanderRestriction(live)
      } catch {
        // 已存在的 teammate 由 agent/created 接管
      }
      return { member: existing, created: false }
    }
    const promptText = buildCommanderPrompt({
      cwd,
      goal,
      docs,
      config,
      modelLabel: 'Agent Teams 路由',
      commanderId: `teammate:${config.commanderName}`,
    })
    const spawned = await team.spawnTeammate(agent, {
      name: config.commanderName,
      description: '指挥员（架构设计 + 督察指挥；可写但默认不动手、可续接）',
      prompt: [{ type: 'text', text: promptText }],
      context: 'fresh',
      provider: config.provider,
      signal,
    })
    const member = spawned?.member ?? spawned
    // agent/created 可能早于 teammate 登记完成；这里再补一次工具面收紧。
    try {
      const live = ctx.get('agents')?.get?.(member.id)
      if (live) applyCommanderRestriction(live)
    } catch {
      // 取不到 live agent 时依赖 agent/created 的接管
    }
    commanderStarted.add(agent.session?.header?.id ?? agent.id)
    contractSynced.add(member.id)
    return { member, created: true }
  }

  // ---- 指挥请求 pending（持久化 + 无超时等待） ----
  const memoryPending = new Map()
  const memoryInterruptions = new Map()
  const memoryApprovals = new Map()
  const memoryRounds = new Map()
  let pendingUnitPromise

  /**
   * 持久化：直接写 JSON 文件，不依赖宿主的 storage form。
   *
   * 宿主只挂载 `domain` 数据形式（`ctx.storage.domain`），`form('kv')` 必然抛
   * `form-not-mounted`；2.9.6 及以前把它 catch 掉静默降级为内存，重启就丢 pending。
   * 这里改为自有文件，行为与宿主版本无关。
   */
  const stateFilePath = config.statePath && String(config.statePath).trim().length > 0
    ? resolve(String(config.statePath))
    : join(homedir(), '.dsh', 'commander', 'state.json')
  let storePromise

  /** 懒加载状态存储（独立模块：原子写 / 0600 / 跨进程锁 / 损坏隔离 / 修剪 / 迁移）。 */
  async function stateStore() {
    if (storePromise === undefined) {
      storePromise = createStateStore({
        path: stateFilePath,
        pluginVersion: PLUGIN_VERSION,
        logger: ctx.logger,
        ...(Number(config.stateMaxBytes) > 0 ? { maxBytes: Number(config.stateMaxBytes) } : {}),
        ...(Number(config.stateKeepPerTable) > 0 ? { keepPerTable: Number(config.stateKeepPerTable) } : {}),
      })
    }
    return storePromise
  }

  /** 持久化状态（status / doctor 共用）。 */
  async function persistenceFacts() {
    const store = await stateStore()
    const snapshot = store.snapshot()
    let mode
    try {
      const info = await fsp.stat(store.path)
      mode = (info.mode & 0o777).toString(8).padStart(3, '0')
    } catch {
      mode = undefined
    }
    return { store, snapshot, counts: store.counts(), mode }
  }

  /**
   * 设置/清除某个 Lead 的接管覆盖（只在本次进程内有效）。
   *
   * 不落盘是刻意的：接管状态属于「此刻这一轮」的选择，重启后按启动口径重新初始化，
   * 上一次的 full 不该在新进程里复活。需要长期偏好属于另一个话题。
   */
  async function setTakeoverOverride(leadId, state, source = 'user') {
    if (!leadId) return
    if (state === undefined || state === null) {
      takeoverOverrides.delete(leadId)
      return
    }
    const normalized = normalizeTakeover(state)
    if (!normalized) return
    takeoverOverrides.set(leadId, { state: normalized, source, at: Date.now() })
  }

  /** 接管状态一行（status / doctor 共用）。 */
  function takeoverLine(agent) {
    const { state, source } = currentTakeover(agent)
    const label = TAKEOVER_LABELS[state] ?? state
    const why = TAKEOVER_SOURCES[source] ?? source
    return `${label}（${state}，${why}）`
  }

  /** 自动交接一行：只报状态，不报轮次（进度以任务为单位看）。 */
  function handoffLine(agent) {
    if (currentTakeover(agent).state !== 'full') return '未启用（只有全接管才自动交接）'
    const state = handoffStates.get(agent.id)
    if (state === undefined) return '待触发（还没见过这个会话的 idle）'
    // 括号里的计数是诊断用的：0/0 说明事件根本没到，>0 说明是门禁挡住的。
    const seen = `（idle×${state.idleSeen}，turn/end×${state.turnEndSeen}）`
    if (state.stopping) return `正在停止${seen}`
    if (state.stopped) return `已停运（指挥员挂死或超时；重新设定接管状态即可恢复）${seen}`
    if (state.inFlight) return `等待指挥员回复${seen}`
    if (state.interrupted) return `你刚插过话，这一轮交还给你${seen}`
    return `待触发（等这一轮结束）${seen}`
  }

  /**
   * 把「接管状态已切换」写进会话，作为一条 runtime-context 的 user 消息。
   *
   * 为什么不用 developer/message：宿主在 `projectToolUpdates` 里会把 developer 消息
   * 过滤掉（toolUpdate 未定义时一律剔除），只有 tool-addition 那类才会留下——写进去
   * 模型也读不到。runtime-context 是宿主自己给模型注入运行期事实的通道，模型一定看得到。
   *
   * `source.kind` 不是 'user'，所以不会触发「全接管自动降为部分接管」，
   * 也不会清零「已咨询指挥员」。
   */
  function announceTakeover(sessionId, state) {
    try {
      const session = ctx.get('sessions')?.get?.(sessionId)
      if (!session || typeof session.append !== 'function') return false
      session.append(
        'user/message',
        {
          role: 'user',
          id: `commander-takeover-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
          content: [{ type: 'text', text: t('takeover.announce.' + state) }],
          source: { kind: 'runtime-context' },
        },
        { surfaceOp: 'append' },
      )
      return true
    } catch (error) {
      ctx.logger?.warn?.(`dsh-commander: 接管状态通知写入失败：${error && error.message ? error.message : error}`)
      return false
    }
  }

  // ---- 全接管：自动交接 ----
  //
  // 用户口径：full 不是"加门禁"，是**换驾驶员**——主agent 每轮停下就把输出交回
  // 指挥员，钩子等它的指令，再把它作为新一轮的输入唤醒主agent。轮次不限，只由
  // 指挥员声明任务完成来结束；中断就是中断，不改接管状态。
  const handoffStates = new Map()
  /** 指挥员多久不回就判定卡住（毫秒）；轮次不限，但"无限等待"是另一回事。 */
  const HANDOFF_WAIT_MS = 20 * 60 * 1000
  const HANDOFF_POLL_MS = 30 * 1000

  function handoffStateFor(agent) {
    const existing = handoffStates.get(agent.id)
    if (existing !== undefined) return existing
    const state = {
      agent,
      inFlight: false,
      interrupted: false,
      stopping: false,
      stopped: false,
      turnEnded: false,
      idleSeen: 0,
      turnEndSeen: 0,
      lastSeq: 0,
      lastAt: 0,
      run: undefined,
      requested: false,
    }
    handoffStates.set(agent.id, state)
    return state
  }

  /** 指挥员成员；取不到返回 undefined。 */
  function commanderMember(agent) {
    try {
      const members = ctx.get('agentTeams')?.listMembers?.(agent) ?? []
      return members.find((row) => row.role === 'teammate' && row.name === config.commanderName)
    } catch {
      return undefined
    }
  }

  /**
   * 等指挥员回复，但带看门狗：它挂死/超时就停运，不无限挂着。
   * @returns {{kind: string, text?: string}} waitCommander 的原结果，或 {kind:'dead'|'timeout'}
   */
  async function waitCommanderGuarded(agent, requestId) {
    let settled = false
    const startedAt = Date.now()
    const watchdog = (async () => {
      while (!settled) {
        await new Promise((done) => {
          const timer = setTimeout(done, HANDOFF_POLL_MS)
          timer.unref?.()
        })
        if (settled) return undefined
        if (commanderDead(commanderMember(agent))) return { kind: 'dead' }
        if (Date.now() - startedAt > HANDOFF_WAIT_MS) return { kind: 'timeout' }
      }
      return undefined
    })()
    try {
      return await Promise.race([waitCommander(agent, requestId), watchdog])
    } finally {
      settled = true
    }
  }

  /** 把指挥员的指令注入回主agent，并唤醒它开新一轮。 */
  function wakeWithInstruction(agent, text, commanderId) {
    const base = {
      role: 'user',
      id: `commander-handoff-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      content: [{ type: 'text', text: renderInstruction(text) }],
    }
    try {
      agent.followup({ ...base, source: { ...HANDOFF_SOURCE, senderSessionId: commanderId } })
      return true
    } catch (error) {
      // senderSessionId 缺失/不合法时退回 runtime-context：语义弱一点，但能送达。
      try {
        agent.followup({ ...base, source: { kind: 'runtime-context' } })
        return true
      } catch (fallbackError) {
        ctx.logger?.warn?.(
          `dsh-commander: 自动交接唤醒失败：${fallbackError && fallbackError.message ? fallbackError.message : fallbackError}`,
        )
        return false
      }
    }
  }

  /**
   * 本轮工具摘要：把 `tool/call` 与 `tool/result` 配成一行一条。
   *
   * 只给指挥员看「干了什么、成没成」，参数截断到 60 字——它要判断方向，
   * 不需要重读全部输出。
   */
  function summarizeTools(session, fromSeq) {
    let events = []
    try {
      events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents(fromSeq) : []
    } catch {
      events = []
    }
    const calls = new Map()
    const rows = []
    for (const event of events) {
      if (event?.type === 'tool/call') {
        const callId = event.data?.callId
        const name = String(event.data?.name ?? 'tool')
        const args = String(event.data?.arguments ?? '')
        const row = { name, args, failed: undefined }
        if (callId !== undefined) calls.set(callId, row)
        rows.push(row)
        continue
      }
      if (event?.type === 'tool/result') {
        const row = calls.get(event.data?.callId)
        if (row !== undefined) row.failed = Boolean(event.error) || event.data?.message?.isError === true
      }
    }
    return rows
      .filter((row) => row.failed !== undefined || row.args.length > 0)
      .map((row) => {
        const compact = row.args.replace(/\s+/g, ' ').trim()
        const shown = compact.length > 60 ? `${compact.slice(0, 60)}…` : compact
        const mark = row.failed === undefined ? '…' : row.failed ? '✗' : '✓'
        return `${mark} ${row.name}${shown.length > 0 ? `: ${shown}` : ''}`
      })
  }

  async function driveHandoff(state) {
    const agent = state.agent
    const header = agent?.session?.header
    const isLead = Boolean(header) && !header.parentSession && !commanderIds.has(agent.id)
    const ready = shouldHandoff({
      stopping: state.stopping,
      inFlight: state.inFlight,
      isLead,
      takeover: currentTakeover(agent).state,
      status: agent.status,
      turnEnded: state.turnEnded,
      stopped: state.stopped,
      interrupted: state.interrupted,
    })
    if (!ready) {
      // 用户刚插过话：只跳过这一轮，状态不动。
      if (state.interrupted) state.interrupted = false
      return
    }
    // 一次 turn/end 只交接一次。
    state.turnEnded = false
    const session = agent.session
    const fromSeq = state.lastSeq
    const report = lastAssistantText(session, fromSeq, state.lastAt)
    const tools = summarizeTools(session, fromSeq)
    state.lastSeq = session?.seq ?? 0
    state.lastAt = Date.now()
    if (report.trim().length === 0 && tools.length === 0) return
    state.inFlight = true
    try {
      const cwd = await resolveCwd(ctx, agent, undefined).catch(() => process.cwd())
      const task = currentGoalObjective(agent)
      const sent = await sendToCommander(agent, undefined, renderReport({ report, task, tools }), undefined, cwd)
      const result = await waitCommanderGuarded(agent, sent?.requestId)
      if (state.stopping) return
      // 等回复期间用户插话了：方向盘已经交还给用户，这条指令不再注入。
      if (state.interrupted) {
        state.interrupted = false
        ctx.logger?.info?.('dsh-commander: 等回复期间用户插话，本次交接让位')
        return
      }
      // 指挥员挂死 / 超时：停运即可，不无限挂着，也不改接管状态。
      if (result?.kind === 'dead' || result?.kind === 'timeout') {
        state.stopped = true
        ctx.logger?.warn?.(`dsh-commander: 自动交接停运（${result.kind}）`)
        return
      }
      if (result?.kind !== 'reply') {
        ctx.logger?.warn?.(`dsh-commander: 自动交接没拿到回复（${result?.kind ?? 'unknown'}）`)
        return
      }
      const verdict = classifyReply(result.text)
      if (verdict === 'finish') {
        ctx.logger?.info?.('dsh-commander: 自动交接收到「允许结束」，停止驱动')
        return
      }
      const pending = await loadPending(rootSessionIdOf(agent)).catch(() => undefined)
      wakeWithInstruction(agent, result.text, pending?.commanderId ?? '')
    } catch (error) {
      ctx.logger?.warn?.(`dsh-commander: 自动交接失败：${error && error.message ? error.message : error}`)
    } finally {
      state.inFlight = false
    }
  }

  /** 同一个 agent 的驱动串行化（照 goal-round-driver 的骨架）。 */
  function requestHandoffDrive(state) {
    if (state.stopping) return
    state.requested = true
    if (state.run !== undefined) return
    const run = ctx.agents.withoutInitiator(async () => {
      while (state.requested && !state.stopping) {
        state.requested = false
        try {
          await driveHandoff(state)
        } catch (error) {
          ctx.logger?.warn?.(`dsh-commander: 交接驱动异常：${error && error.message ? error.message : error}`)
        }
      }
    })
    state.run = run
    const retire = () => {
      state.run = undefined
      if (state.requested && !state.stopping) requestHandoffDrive(state)
    }
    run.then(retire, retire)
  }

  ctx.effect(function* () {
    ctx.on('agent/status', ({ agent, status }) => {
      if (!agent || status !== 'idle') return
      const state = handoffStateFor(agent)
      state.idleSeen += 1
      requestHandoffDrive(state)
      // turn/end 可能比 agent/status 晚一步到：顺序不对时这里先跳过了一次，
      // 补一次延迟重试，别把这次交接丢掉。
      if (!state.turnEnded && !state.inFlight && !state.stopped) {
        const timer = setTimeout(() => requestHandoffDrive(handoffStateFor(agent)), 300)
        timer.unref?.()
      }
    })
    ctx.on('session/event', (session, event) => {
      const agent = ctx.get('agents')?.get?.(session.id)
      if (!agent || agent.session !== session) return
      // 用户发言：只有「正在等指挥员回复」时才算是抢占方向盘。
      // 平时用户发言是这一轮的开始，不是打断——不能因此跳过交接。
      if (event?.type === 'user/message' && event.data?.source?.kind === 'user') {
        const state = handoffStateFor(agent)
        if (state.inFlight) state.interrupted = true
        return
      }
      if (event?.type === 'turn/end') {
        const state = handoffStateFor(agent)
        if (event.data?.reason?.kind === 'aborted') {
          state.interrupted = true
          return
        }
        state.turnEnded = true
        state.turnEndSeen += 1
        // 真正的触发点：一轮真的结束了就请求交接（agent/status 只是兜底）。
        requestHandoffDrive(state)
      }
    })
    // 排队后世界变了：状态已不是全接管就拒绝这条交接指令，绝不带着过期指令开跑。
    ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
      const mine = (messages ?? []).find(
        (message) =>
          message?.source?.kind === 'agent-message' && String(message.id ?? '').startsWith('commander-handoff-'),
      )
      if (mine === undefined) return next()
      if (currentTakeover(agent).state !== 'full') {
        handoffStateFor(agent).stopped = true
        return { kind: 'reject' }
      }
      return next()
    })
    ctx.on('agent/disposed', ({ agent }) => {
      const state = handoffStates.get(agent.id)
      if (state !== undefined) {
        state.stopping = true
        handoffStates.delete(agent.id)
      }
    })
    yield () => {
      for (const state of handoffStates.values()) state.stopping = true
      handoffStates.clear()
    }
  })

  async function pendingUnit() {
    if (pendingUnitPromise === undefined) {
      pendingUnitPromise = (async () => {
        const store = await stateStore()
        return {
          loadAll: async () => ({ tables: store.snapshot().tables }),
          putRecord: async (table, key, record) => {
            await store.put(table, key, record)
          },
          deleteRecord: async (table, key) => {
            await store.remove(table, key)
          },
          close: async () => {},
        }
      })()
    }
    return pendingUnitPromise
  }

  async function loadPending(leadId) {
    const unit = await pendingUnit()
    if (unit) {
      try {
        const all = await unit.loadAll()
        return all.tables.pending?.[leadId]
      } catch {
        // 退回内存
      }
    }
    return memoryPending.get(leadId)
  }

  async function savePending(leadId, record) {
    memoryPending.set(leadId, record)
    const unit = await pendingUnit()
    if (unit) {
      try {
        await unit.putRecord('pending', leadId, record)
      } catch {
        // 内存已保存
      }
    }
  }

  async function clearPending(leadId) {
    memoryPending.delete(leadId)
    const unit = await pendingUnit()
    if (unit) {
      try {
        await unit.deleteRecord('pending', leadId)
      } catch {
        // 忽略
      }
    }
  }

  async function loadInterruption(sessionId) {
    const unit = await pendingUnit()
    if (unit) {
      try {
        const all = await unit.loadAll()
        return all.tables.interruptions?.[sessionId]
      } catch {
        // 退回内存
      }
    }
    return memoryInterruptions.get(sessionId)
  }

  async function saveInterruption(sessionId, record) {
    memoryInterruptions.set(sessionId, record)
    const unit = await pendingUnit()
    if (unit) {
      try {
        await unit.putRecord('interruptions', sessionId, record)
      } catch {
        // 内存已保存
      }
    }
  }

  async function mergeInterruption(sessionId, patch) {
    const previous = (await loadInterruption(sessionId)) ?? {}
    await saveInterruption(sessionId, { ...previous, ...patch, sessionId })
  }

  async function loadApproval(leadId) {
    const unit = await pendingUnit()
    if (unit) {
      try {
        const all = await unit.loadAll()
        return all.tables.approvals?.[leadId]
      } catch {
        // 退回内存
      }
    }
    return memoryApprovals.get(leadId)
  }

  async function saveApproval(leadId, record) {
    memoryApprovals.set(leadId, record)
    const unit = await pendingUnit()
    if (unit) {
      try {
        await unit.putRecord('approvals', leadId, record)
      } catch {
        // 内存已保存
      }
    }
  }

  async function clearApproval(leadId) {
    memoryApprovals.delete(leadId)
    const unit = await pendingUnit()
    if (unit) {
      try {
        await unit.deleteRecord('approvals', leadId)
      } catch {
        // 忽略
      }
    }
  }

  async function loadRound(leadId) {
    const unit = await pendingUnit()
    if (unit) {
      try {
        const all = await unit.loadAll()
        return all.tables.rounds?.[leadId]
      } catch {
        // 退回内存
      }
    }
    return memoryRounds.get(leadId)
  }

  async function saveRound(leadId, record) {
    memoryRounds.set(leadId, record)
    const unit = await pendingUnit()
    if (unit) {
      try {
        await unit.putRecord('rounds', leadId, record)
      } catch {
        // 内存已保存
      }
    }
  }

  async function bumpRound(leadId, decision, requestId) {
    const previous = await loadRound(leadId)
    const round = {
      count: (previous?.count ?? 0) + 1,
      lastDecision: decision,
      lastRequestId: requestId,
      updatedAt: Date.now(),
    }
    await saveRound(leadId, round)
    return round
  }

  /** 插件重载/会话恢复时把 KV 里的放行读回内存。 */
  async function hydrateApproval(agent) {
    if (!agent?.session?.header || agent.session.header.parentSession) return
    const record = await loadApproval(agent.id)
    if (record) approvedSessions.set(agent.id, record)
    else approvedSessions.delete(agent.id)
  }

  function assistantTextOfContent(content) {
    if (!Array.isArray(content)) return ''
    return content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
  }

  function lastAssistantText(session, fromSeq, sinceTime = 0) {
    let events = []
    try {
      events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents(fromSeq) : session?.events ?? []
    } catch {
      events = session?.events ?? []
    }
    let text = ''
    for (const event of events) {
      if (event?.type !== 'assistant/message') continue
      if (typeof event.time === 'number' && event.time < sinceTime) continue
      const candidate = assistantTextOfContent(event.data?.message?.content)
      if (candidate.length > 0) text = candidate
    }
    return text
  }

  function isDescendantSession(session, leadId) {
    let current = session
    let depth = 0
    while (current?.header?.parentSession && depth < 32) {
      if (current.header.parentSession === leadId) return true
      let parent
      try {
        parent = ctx.get('sessions')?.get?.(current.header.parentSession)
      } catch {
        parent = undefined
      }
      if (!parent) return false
      current = parent
      depth += 1
    }
    return false
  }

  /**
   * 阻塞等待指挥员这一轮结束（无超时）。
   * - 指挥员 turn/end：返回回复并清除 pending；
   * - 其他工程组/子agent turn/end：返回 interrupt，保留 pending（验收后再次 wait）；
   * - 用户中断：中止工具，pending 保留，供下一轮恢复。
   */
  async function waitCommander(agent, requestId, signal) {
    const leadId = agent?.session?.header?.id ?? agent?.id
    const pending = await loadPending(leadId)
    if (!pending) throw new Error('dsh-commander: 没有未完成的指挥请求；先 commander(action=say) 发起咨询。')
    if (typeof requestId === 'string' && requestId.trim().length > 0 && requestId.trim() !== pending.requestId) {
      throw new Error(`dsh-commander: requestId 不匹配（当前 pending 是 ${pending.requestId}）。`)
    }
    // 上个进程遗留的请求：回复永远不会再来，别让 wait 永久阻塞。
    if (isStalePending(pending)) {
      await clearPending(leadId).catch(() => {})
      return {
        kind: 'stale',
        text: t('pending.stale', {
          requestId: pending.requestId,
          waiting: Math.max(0, Math.round((PROCESS_START - Number(pending.sentAt ?? 0)) / 1000)),
        }),
        requestId: pending.requestId,
      }
    }
    // 已在全局 turn/end 中缓存了回复：直接返回，避免 wait 中断后永久阻塞。
    if (pending.lastReply && typeof pending.lastReply.text === 'string' && pending.lastReply.text.length > 0) {
      await clearPending(leadId)
      return { kind: 'reply', text: pending.lastReply.text, requestId: pending.requestId, codeState: pending.codeState }
    }
    // 指挥员已 failed：不再无限等待。
    try {
      const members = ctx.get('agentTeams')?.listMembers?.(agent) ?? []
      const member = members.find((row) => row.id === pending.commanderId || row.name === pending.target)
      if (member?.status === 'failed') {
        await clearPending(leadId)
        return {
          kind: 'failed',
          text: `指挥员状态为 failed，请求 ${pending.requestId} 已终止；请检查 list_agents 后重新 say。`,          requestId: pending.requestId,
          codeState: pending.codeState,
        }
      }
    } catch {
      // 读不到成员状态就继续等待
    }
    // 已经结束（同一进程内、基线之后有事件）则立即返回。
    const live = ctx.get('agents')?.get?.(pending.commanderId)
    if (live && live.status === 'idle' && pending.baselineSeq > 0 && (live.session?.seq ?? 0) > pending.baselineSeq) {
      const text = lastAssistantText(live.session, pending.baselineSeq, pending.sentAt)
      if (text.length > 0 && parseRequestId(text) === pending.requestId) {
        await clearPending(leadId)
        return { kind: 'reply', text, requestId: pending.requestId, codeState: pending.codeState }
      }
    }
    // 指挥员可能在 wait 之前就已完成并释放：从持久会话里补一次检查。
    {
      try {
        const session = ctx.get('sessions')?.get?.(pending.commanderId)
        if (session && typeof session.snapshotEvents === 'function') {
          const events = session.snapshotEvents(0)
          const hasReplyAfterSend = events.some(
            (event) => event?.type === 'assistant/message' && typeof event.time === 'number' && event.time >= pending.sentAt,
          )
          if (hasReplyAfterSend) {
            const text = lastAssistantText(session, 0, pending.sentAt)
            if (text.length > 0) {
              const replyReq = parseRequestId(text)
              if (replyReq === pending.requestId) {
                await clearPending(leadId)
                return { kind: 'reply', text, requestId: pending.requestId, codeState: pending.codeState }
              }
              if (replyReq) {
                // 旧请求的迟到回复：不结束等待，继续等本请求（落到下方订阅）。
              } else {
                await clearPending(leadId)
                return {
                  kind: 'failed',
                  text: '指挥员回复缺少请求号，无法关联；本请求仍在等待。如确认未处理，可用 commander status / cancel。',
                  requestId: pending.requestId,
                  codeState: pending.codeState,
                }
              }
            }
          }
        }
      } catch {
        // 读不到持久会话就继续检查成员状态
      }
    }
    return new Promise((resolve, reject) => {
      let settled = false
      let off
      let offDisposed
      const cleanup = () => {
        if (typeof off === 'function') {
          try {
            off()
          } catch {
            // 已释放
          }
        }
        if (typeof offDisposed === 'function') {
          try {
            offDisposed()
          } catch {
            // 已释放
          }
        }
        signal?.removeEventListener?.('abort', onAbort)
      }
      const finish = (result) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      }
      const onAbort = () => {
        if (settled) return
        settled = true
        cleanup()
        reject(signal?.reason instanceof Error ? signal.reason : new Error('指挥等待被用户中断；pending 已保留，可再次 wait 恢复'))
      }
      signal?.addEventListener?.('abort', onAbort, { once: true })
      off = ctx.on('session/event', (session, event) => {
        if (settled || !session || event?.type !== 'turn/end') return
        if (session.id === pending.commanderId) {
          const text = lastAssistantText(session, pending.baselineSeq, pending.sentAt)
          const replyReq = parseRequestId(text)
          if (text.length > 0 && replyReq && replyReq !== pending.requestId) {
            // 旧请求的迟到回复：忽略这个 turn/end，不清 pending，继续等本请求。
            return
          }
          const matched = text.length > 0 && replyReq === pending.requestId
          clearPending(leadId).catch(() => {})
          finish({
            kind: matched ? 'reply' : 'failed',
            text: matched
              ? text
              : text.length > 0
                ? t('pending.noRequestId')
                : t('pending.emptyReply'),
            requestId: pending.requestId,
            codeState: pending.codeState,
          })
          return
        }
        if (session.id === leadId) return
        if (isDescendantSession(session, leadId)) {
          finish({
            kind: 'interrupt',
            text: t('pending.interrupt', { sessionId: session.id }),
            requestId: pending.requestId,
          })
        }
      })
      offDisposed = ctx.on('agent/disposed', ({ agent: disposed }) => {
        if (settled || disposed?.id !== pending.commanderId) return
        clearPending(leadId).catch(() => {})
        finish({
          kind: 'failed',
          text: t('pending.disposed', { requestId: pending.requestId }),
          requestId: pending.requestId,
          codeState: pending.codeState,
        })
      })
    })
  }

  async function cancelCommander(agent) {
    const leadId = agent?.session?.header?.id ?? agent?.id
    const pending = await loadPending(leadId)
    if (!pending) return { cancelled: false, requestId: undefined }
    await clearPending(leadId)
    return { cancelled: true, requestId: pending.requestId }
  }

  /** 通过 Agent Teams 给指挥员发一条消息（带 requestId，登记 pending）。 */
  async function sendToCommander(agent, target, message, signal, cwd) {
    const leadId = agent?.session?.header?.id ?? agent?.id
    const existing = await loadPending(leadId)
    if (existing && !isStalePending(existing)) {
      throw new Error(t('pending.exists', { requestId: existing.requestId }))
    }
    if (existing) {
      // 上个进程遗留的请求不会再有回复：让新 say 直接接管，不再卡住。
      ctx.logger?.info?.(`dsh-commander: 清理陈旧 pending ${existing.requestId}（来自上个进程）`)
      await clearPending(leadId).catch(() => {})
    }
    const team = teamService()
    let members = []
    try {
      members = team.listMembers(agent)
    } catch {
      members = []
    }
    const named = typeof target === 'string' && target.trim().length > 0 ? target.trim() : config.commanderName
    const hit = (Array.isArray(members) ? members : []).find((member) => member.name === named)
    const requestId = `req-${randomUUID()}`
    const codeState = await computeCodeState(cwd)
    const text = `[REQ ${requestId}]\n[CODE_STATE ${codeState}]\n[契约] 回复头部需含「决定：…」「请求：${requestId}」「适用状态：${codeState}」；缺请求号不会被采用。\n${message}`
    let commanderId
    let messageId
    let targetLabel
    if (!hit) {
      // 兼容历史子agent卡片：按 session id 续接（旧 commander-<uuid> 也能被重新链接）。
      const legacy = await listCommanderChildren(agent, signal)
      const legacyHit = legacy.find((row) => row.id === named)
      if (!legacyHit) {
        const names = (Array.isArray(members) ? members : []).map((member) => member.name).join('、') || '（无）'
        throw new Error(t('pending.noMember', { name: named, names }))
      }
      commanderId = legacyHit.id
      targetLabel = legacyHit.id
      await applyAdvisorModel(commanderId)
      messageId = await ctx.subagents.sendMessage(agent, commanderId, [{ type: 'text', text }], { signal })
    } else {
      commanderId = hit.id
      targetLabel = hit.name
      await applyAdvisorModel(commanderId)
      messageId = await team.sendMessage(agent, {
        target: hit.name,
        content: [{ type: 'text', text }],
        signal,
      })
    }
    const live = ctx.get('agents')?.get?.(commanderId)
    const baselineSeq = live?.session?.seq ?? 0
    const pending = {
      requestId,
      leadId,
      commanderId,
      target: targetLabel,
      sentAt: Date.now(),
      baselineSeq,
      codeState,
    }
    await savePending(leadId, pending)
    return { messageId, requestId, target: targetLabel, member: hit ?? { id: commanderId, name: targetLabel }, pending }
  }

  /** 列出指挥员 teammate（含历史遗留的子agent卡片）。 */
  async function commanderRoster(agent, signal) {
    const lines = [`## ${t('roster.title')}`, '']
    let teammate
    try {
      const members = teamService().listMembers(agent)
      teammate = (Array.isArray(members) ? members : []).find(
        (member) => member.role === 'teammate' && member.name === config.commanderName,
      )
    } catch {
      teammate = undefined
    }
    if (teammate) {
      lines.push(
        `- ${t('roster.teammate', {
          name: teammate.name,
          status: teammate.status ?? 'unknown',
          id: teammate.id,
        })}`,
      )
    } else {
      lines.push(`- ${t('roster.missing')}`)
    }
    const legacy = await listCommanderChildren(agent, signal)
    if (legacy.length > 0) {
      lines.push('', `### ${t('roster.legacy')}`)
      for (const row of legacy) lines.push(`- \`${row.id}\` · ${row.label}`)
      lines.push('', t('roster.legacyHint'))
    }
    return { text: lines.join('\n'), teammate, legacy }
  }

  

  

  /** 指挥状态摘要（不派生 LLM）。 */
  // ---- 受控检查（checks）：只执行配置里列出的命令 ----
  const CHECK_MAX_LINES = 200
  const CHECK_MAX_BYTES = 32 * 1024
  let checkRunning = false

  /** 解析 `checkCommands`：`name = command` 或直接 command。 */
  function checkCatalog() {
    return (config.checkCommands ?? [])
      .map((entry) => String(entry ?? '').trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const named = /^([A-Za-z0-9_.:-]+)\s*=\s*(.+)$/.exec(entry)
        if (named) return { name: named[1], command: named[2].trim() }
        const words = entry.split(/\s+/).slice(0, 2).join(' ')
        return { name: words, command: entry }
      })
  }

  /** 截断输出：保留末尾若干行/字节。 */
  function tailText(text, maxLines, maxBytes) {
    let value = String(text ?? '')
    let truncated = false
    if (Buffer.byteLength(value, 'utf8') > maxBytes) {
      value = value.slice(-maxBytes)
      truncated = true
    }
    const lines = value.split(/\r?\n/)
    if (lines.length > maxLines) {
      value = lines.slice(-maxLines).join('\n')
      truncated = true
    }
    return { text: value, truncated }
  }

  /** 杀掉整棵进程树：POSIX 用进程组，Windows 用 taskkill /T。 */
  function killTree(child) {
    if (!child?.pid) return
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).unref?.()
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          // 忽略
        }
      }
      return
    }
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        // 忽略
      }
    }
  }

  /** 执行一条受控检查。 */
  function spawnCheck(item, cwd) {
    return new Promise((resolvePromise) => {
      const startedAt = Date.now()
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false
      const child = spawn(item.command, {
        cwd,
        shell: true,
        detached: process.platform !== 'win32',
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const timer = setTimeout(() => {
        timedOut = true
        killTree(child)
      }, config.checkTimeoutMs)
      const collect = (chunk, target) => {
        const text = String(chunk)
        const combined = target + text
        // 只保留尾部，避免长输出吃内存
        return combined.length > CHECK_MAX_BYTES * 2 ? combined.slice(-CHECK_MAX_BYTES * 2) : combined
      }
      child.stdout?.on('data', (chunk) => {
        stdout = collect(chunk, stdout)
      })
      child.stderr?.on('data', (chunk) => {
        stderr = collect(chunk, stderr)
      })
      const finish = (exitCode, error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const merged = [stdout.trim(), stderr.trim()].filter((part) => part.length > 0).join('\n')
        const tail = tailText(merged, CHECK_MAX_LINES, CHECK_MAX_BYTES)
        resolvePromise({
          item,
          exitCode,
          timedOut,
          durationMs: Date.now() - startedAt,
          output: tail.text,
          truncated: tail.truncated,
          error: error ? (error?.message ?? String(error)) : undefined,
        })
      }
      child.on('error', (error) => finish(undefined, error))
      child.on('close', (code) => finish(code ?? (timedOut ? undefined : 1)))
    })
  }

  /** commander(action=checks)：运行/列出受控检查。 */
  async function runChecks(agent, cwd, requested) {
    const catalog = checkCatalog()
    if (catalog.length === 0) return { kind: 'empty', text: t('checks.empty') }
    if (!requested) {
      const items = catalog.map((row) => `- ${row.name}：\`${row.command}\``).join('\n')
      return { kind: 'list', text: t('checks.list', { items }) }
    }
    const item = catalog.find((row) => row.name === requested)
    if (!item) {
      return {
        kind: 'unknown',
        text: t('checks.unknown', { name: requested, names: catalog.map((row) => row.name).join('、') }),
      }
    }
    if (checkRunning) return { kind: 'busy', text: t('checks.busy') }
    checkRunning = true
    try {
      const result = await spawnCheck(item, cwd)
      const status = result.timedOut
        ? t('checks.timeout', { limit: Math.round(config.checkTimeoutMs / 1000) })
        : result.exitCode === 0
          ? 'PASS'
          : 'FAIL'
      const head = t('checks.result', {
        name: item.name,
        status,
        exitCode: result.exitCode ?? '—',
        duration: `${(result.durationMs / 1000).toFixed(1)}s`,
      })
      const parts = [head]
      if (result.truncated) {
        parts.push(t('checks.truncated', { lines: CHECK_MAX_LINES, bytes: CHECK_MAX_BYTES }))
      }
      if (result.output.length > 0) parts.push('```\n' + result.output + '\n```')
      return {
        kind: result.timedOut ? 'timeout' : result.exitCode === 0 ? 'pass' : 'fail',
        text: parts.join('\n'),
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      }
    } finally {
      checkRunning = false
    }
  }

  // ---- doctor：一条命令说清"现在是健康还是哪里断了" ----
  const PLUGIN_DIR = (() => {
    try {
      return fileURLToPath(new URL('.', import.meta.url))
    } catch {
      return undefined
    }
  })()

  /** 扫描 profile：`~/.dsh/profiles/<name>/node_modules/@local/dsh-commander` 指向哪里。 */
  async function profileMounts() {
    const roots = []
    const profilesDir = join(homedir(), '.dsh', 'profiles')
    let names = []
    try {
      names = await fsp.readdir(profilesDir)
    } catch {
      return roots
    }
    for (const name of names) {
      const link = join(profilesDir, name, 'node_modules', '@local', 'dsh-commander')
      try {
        const real = await fsp.realpath(link)
        roots.push({ profile: name, path: real })
      } catch {
        // 未安装
      }
    }
    return roots
  }

  /** 读某个目录下 package.json 的版本（读不到返回 undefined）。 */
  async function packageVersionAt(dir) {
    if (!dir) return undefined
    try {
      const raw = await fsp.readFile(join(dir, 'package.json'), 'utf8')
      const parsed = JSON.parse(raw)
      return typeof parsed?.version === 'string' ? parsed.version : undefined
    } catch {
      return undefined
    }
  }

  /** commander(action=doctor)：PASS/WARN/FAIL 自检，默认只读。 */
  async function doctorReport(agent, cwd, options = {}) {
    const rows = []
    const add = (level, title, detail) => rows.push({ level, title, detail })
    const suggestions = []

    // 1) 版本与安装
    const mounts = await profileMounts()
    const diskVersion = await packageVersionAt(PLUGIN_DIR)
    let installDetail = `目录 ${PLUGIN_DIR ?? '未知'}，运行中 ${PLUGIN_VERSION}`
    if (diskVersion && diskVersion !== PLUGIN_VERSION) {
      installDetail += `，磁盘 package ${diskVersion}（重启后生效）`
    }
    const mountVersions = []
    for (const mount of mounts) mountVersions.push(await packageVersionAt(mount.path))
    const versionDrift = mounts.filter((_row, index) => mountVersions[index] && mountVersions[index] !== PLUGIN_VERSION)
    if (mounts.length === 0) {
      add('WARN', '安装', `${installDetail}；没有找到任何 profile 挂载（可能通过其他方式加载）`)
    } else {
      const normalized = (value) => String(value ?? '').replace(/[\\/]+$/, '').toLowerCase()
      const mismatched = mounts.filter((row) => normalized(row.path) !== normalized(PLUGIN_DIR))
      if (mismatched.length > 0) {
        add(
          'FAIL',
          '安装',
          `${installDetail}；但 profile ${mismatched
            .map((row) => `${row.profile} → ${row.path}`)
            .join('、')} 指向别的目录，运行的不是这份代码`,
        )
        suggestions.push(t('doctor.suggest.mount'))
      } else if (versionDrift.length > 0 || (diskVersion && diskVersion !== PLUGIN_VERSION)) {
        // 目录一致但版本不一致：说明改了代码/换了包还没重启 —— 配置期望未满足，不是故障。
        add(
          'WARN',
          '安装',
          `${installDetail}；profile ${mounts.map((row) => row.profile).join('、')} 指向同一目录，但版本不一致（进程仍在跑旧代码，重启后生效）`,
        )
      } else {
        add('PASS', '安装', `${installDetail}；profile ${mounts.map((row) => row.profile).join('、')} 指向同一目录且版本一致`)
      }
    }

    // 2) 运行态
    let teammate
    try {
      const members = teamService().listMembers(agent)
      teammate = (Array.isArray(members) ? members : []).find(
        (member) => member.role === 'teammate' && member.name === config.commanderName,
      )
    } catch {
      teammate = undefined
    }
    const goal = (() => {
      try {
        return ctx.get('goals')?.get?.(agent)
      } catch {
        return undefined
      }
    })()
    add(
      teammate ? 'PASS' : 'WARN',
      '成员',
      teammate
        ? `${teammate.name}（${teammate.status ?? 'unknown'}，session=${teammate.id}）`
        : '尚未创建；用 /commander start 或直接发需求',
    )
    add(
      'PASS',
      'goal',
      goal ? `${goal.phase}（rounds ${goal.roundsStarted}/${goal.maxGoalRounds}）` : '当前会话没有 goal（正常）',
    )

    // 3) 持久化
    const persist = await persistenceFacts()
    const stateRows = []
    stateRows.push(persist.snapshot.exists ? `存在 ${persist.store.path}` : `未创建 ${persist.store.path}`)
    stateRows.push(`mode ${process.platform === 'win32' ? '不适用（Windows）' : (persist.mode ?? '未知')}`)
    stateRows.push(
      `表 ${STATE_TABLES.map((name) => `${name} ${persist.counts[name] ?? 0}`).join('，')}`,
    )
    if (persist.snapshot.lastWriteAt) {
      stateRows.push(`上次写入 ${new Date(persist.snapshot.lastWriteAt).toLocaleString(config.locale || 'zh-CN', { hour12: false })}`)
    }
    let writable = false
    try {
      await fsp.access(dirname(persist.store.path), 2)
      writable = true
    } catch {
      writable = false
    }
    stateRows.push(writable ? '可写 yes' : '可写 no')
    if (persist.snapshot.readError) stateRows.push(`读错误 ${persist.snapshot.readError}`)
    if (persist.snapshot.writeError) stateRows.push(`写错误 ${persist.snapshot.writeError}`)
    const persistLevel = !writable || persist.snapshot.writeError
      ? 'FAIL'
      : persist.snapshot.readError
        ? 'WARN'
        : persist.mode && persist.mode !== '600' && persist.mode !== '0600' && process.platform !== 'win32'
          ? 'WARN'
          : 'PASS'
    add(persistLevel, '持久化', stateRows.join('｜'))
    if (persist.snapshot.brokenFile) suggestions.push(t('doctor.suggest.stateBroken', { path: persist.snapshot.brokenFile }))
    if (persist.snapshot.lockBusy) suggestions.push(t('doctor.suggest.stateLock', { path: persist.store.lockPath }))
    if (persistLevel === 'WARN' && persist.mode && process.platform !== 'win32') suggestions.push(t('doctor.suggest.perm'))

    // 4) 门禁
    const leadId = agent?.session?.header?.id ?? agent?.id
    const gateOpen = consultedSinceUser.get(leadId) === true
    const takeoverNow = currentTakeover(agent)
    add('PASS', t('label.takeover'), takeoverLine(agent))
    add(
      'PASS',
      '问用户门禁',
      requiresConsultBeforeAsking(takeoverNow.state)
        ? gateOpen
          ? '全接管，但本轮已咨询（可问用户）'
          : '全接管：问用户前必须先 commander say + wait'
        : '不拦（当前接管状态不需要先咨询）',
    )

    // 5) UI 组件
    const windowText = uiWindowText()
    const windowMounted = windowText.startsWith('已挂载')
    // 未挂载只是「配置期望未满足」，不影响对话；只有真故障才 FAIL。
    const windowLevel = windowMounted ? 'PASS' : config.expectTranscriptWindow === true ? 'WARN' : 'PASS'
    add(windowLevel, '历史窗口', windowText)
    if (windowLevel === 'WARN') suggestions.push(t('doctor.suggest.window'))

    // 6) 环境
    let codeState
    try {
      codeState = await computeCodeState(cwd)
    } catch {
      codeState = '（无法计算）'
    }
    const checks = checkCatalog().length
    let commit = ''
    try {
      commit = await describeGitHead(cwd)
    } catch {
      commit = ''
    }
    add(
      'PASS',
      '环境',
      `cwd ${cwd}｜CODE_STATE ${codeState}${commit ? `｜提交 ${commit}（不绑定）` : ''}｜检查项 ${checks} 条`,
    )

    // 7) --fix
    const fixes = []
    if (options.fix === true) {
      const applied = await persist.store.fixPerms()
      fixes.push(...applied)
      const removed = persist.store.prune()
      if (removed > 0) fixes.push(`修剪 ${removed} 条历史记录`)
      await persist.store.flush()
    }

    const fails = rows.filter((row) => row.level === 'FAIL').length
    const warns = rows.filter((row) => row.level === 'WARN').length
    const out = [`## ${t('doctor.title')}`, '']
    for (const row of rows) {
      out.push(`- ${row.level} ${row.title}：${row.detail}`)
    }
    out.push('')
    out.push(
      fails > 0
        ? t('doctor.conclusionFail', { count: fails })
        : warns > 0
          ? t('doctor.conclusionWarn', { count: warns })
          : t('doctor.conclusionOk'),
    )
    if (suggestions.length > 0) {
      out.push(...suggestions.map((item) => `- 下一步：${item}`))
    }
    if (fixes.length > 0) out.push(`- ${t('doctor.fix.applied', { items: fixes.join('，') })}`)
    return { text: out.join('\n'), fails, warns }
  }

  /** UI 历史窗口状态：默认关闭不算故障。 */
  function uiWindowText() {
    try {
      const controller = ctx.get('sessionController')
      const mounted =
        controller?.events?.__transcriptWindow === true || controller?.observeEvent?.__transcriptWindow === true
      if (mounted) {
        const window = controller?.__transcriptWindowConfig
        const detail = window?.turns
          ? `最近 ${window.turns} 个 turn，单页上限 ${window.cap ?? '未知'} 条`
          : '窗口参数未知'
        return `已挂载（${detail}；更早按页加载）`
      }
      return config.expectTranscriptWindow === true
        ? '已启用但未挂载（不影响对话；需要 Client 侧窗口插件）'
        : '未启用（默认关闭，不影响功能）'
    } catch {
      return '无法检测（不影响功能）'
    }
  }

  async function commanderStatus(agent, cwd) {
    const docs = await readDocsState(cwd, config)
    const lines = [`## ${t('status.title')}`, '']
    lines.push(`- ${t('label.pluginVersion')}：${PLUGIN_VERSION}`)
    lines.push(`- ${t('label.docsDir')}：${docsRoot(cwd, config)}`)
    lines.push(`- 文档：${DOC_FILES.map((key) => `${key}.md`).join('、')}`)
    const roundState = await loadRound(agent.session?.header?.id ?? agent.id).catch(() => undefined)
    lines.push(`- ${t('label.rounds')}：${roundState?.count ?? 0}`)
    // 放行绑定的是这个值；以前只在 say 的头部出现，Lead 会误用 git hash 回显。
    let currentCodeState
    try {
      currentCodeState = await computeCodeState(cwd)
    } catch {
      currentCodeState = undefined
    }
    lines.push(`- ${t('label.codeState')}：${currentCodeState ?? '（无法计算）'}`)
    try {
      const commit = await describeGitHead(cwd)
      if (commit) lines.push(`- ${t('status.commit', { commit })}`)
    } catch {
      // 不是 git 仓库就不显示
    }
    const persist = await persistenceFacts()
    const persistParts = [
      persist.snapshot.exists ? t('persist.file', { path: persist.store.path }) : t('persist.notWritten', { path: persist.store.path }),
      `mode ${process.platform === 'win32' ? '不适用（Windows）' : (persist.mode ?? '未知')}`,
      t('persist.lastWrite', {
        time: persist.snapshot.lastWriteAt
          ? new Date(persist.snapshot.lastWriteAt).toLocaleString(config.locale || 'zh-CN', { hour12: false })
          : '未写过',
      }),
    ]
    lines.push(`- ${t('label.persistence')}：${persistParts.join('｜')}`)
    lines.push(`  · ${STATE_TABLES.map((name) => `${name} ${persist.counts[name] ?? 0}`).join('，')}`)
    if (persist.snapshot.readError) lines.push(`  · ${t('persist.readError', { error: persist.snapshot.readError })}`)
    if (persist.snapshot.writeError) lines.push(`  · ${t('persist.writeError', { error: persist.snapshot.writeError })}`)
    if (persist.snapshot.migratedFrom) {
      lines.push(`  · ${t('persist.migrated', { from: persist.snapshot.migratedFrom })}`)
    }
    if (persist.snapshot.brokenFile) lines.push(`  · ${t('persist.broken', { path: persist.snapshot.brokenFile })}`)
    if (roundState?.lastDecision) {
      lines.push(`- ${t('label.lastDecision')}：${roundState.lastDecision}（${roundState.lastRequestId ?? '无请求 id'}）`)
    }
    const goals = ctx.get('goals')
    let goalText = t('status.goalUnavailable')
    try {
      const goal = goals?.get?.(agent)
      goalText = goal
        ? `${goal.objective}（phase=${goal.phase}, rounds=${goal.roundsStarted}/${goal.maxGoalRounds}）${
            goal.phase === 'paused' ? '；paused 只能由用户在界面恢复，模型无权 resume' : ''
          }`
        : '（当前会话没有 goal）'
    } catch (error) {
      goalText = t('status.goalReadFailed', { error: error && error.message ? error.message : String(error) })
    }
    lines.push(`- goal：${goalText}`)
    let teammateText = t('status.notCreated')
    let teammate
    try {
      const members = teamService().listMembers(agent)
      teammate = (Array.isArray(members) ? members : []).find(
        (member) => member.role === 'teammate' && member.name === config.commanderName,
      )
      if (teammate) teammateText = `${teammate.name}（status=${teammate.status ?? 'unknown'}，session=${teammate.id}）`
    } catch (error) {
      teammateText = `（Agent Teams 不可用：${error && error.message ? error.message : String(error)}）`
    }
    lines.push(`- ${t('label.teammate')}：${teammateText}`)
    lines.push(`- ${t('label.uiWindow')}：${uiWindowText()}`)
    lines.push(
      `- ${t('label.model')}：${(
        config.advisorProvider && config.advisorModel
          ? `${config.advisorProvider}/${config.advisorModel}`
          : t('start.modelFallback')
      ).replace(/。$/, '')}${teammate?.model ? `；实际模型 ${teammate.model}` : ''}`,
    )
    try {
      const leadId = agent?.session?.header?.id ?? agent?.id
      const pending = await loadPending(leadId)
      lines.push(
        isStalePending(pending)
          ? `- ${t('label.pending')}：\`${pending.requestId}\`（${t('pending.staleStatus')}）`
          : pending
            ? `- ${t('label.pending')}：\`${pending.requestId}\`（target=${pending.target}，已等待 ${Math.max(0, Math.round((Date.now() - pending.sentAt) / 1000))}s；用 commander.wait 恢复等待）`
            : `- ${t('label.pending')}：（无）`,
      )
      lines.push(`- ${t('label.takeover')}：${takeoverLine(agent)}`)
      lines.push(`- ${t('label.handoff')}：${handoffLine(agent)}`)
      lines.push(
        `- ${t('label.askGate')}：${
          requiresConsultBeforeAsking(currentTakeover(agent).state)
            ? consultedSinceUser.get(leadId) === true
              ? '全接管，但本轮已咨询（可问用户）'
              : '全接管：问用户前必须先 say + wait'
            : '不拦（当前接管状态不需要先咨询）'
        }`,
      )
      const approval = approvedSessions.get(leadId)
      if (approval) {
        let currentState
        try {
          currentState = await computeCodeState(cwd)
        } catch {
          currentState = undefined
        }
        if (currentState && approval.codeState && currentState !== approval.codeState) {
          approvedSessions.delete(leadId)
          await clearApproval(leadId).catch(() => {})
          lines.push('- 允许结束放行：已失效（代码状态已变化，需重新汇报）')
        } else {
          lines.push(
            `- 允许结束放行：有效（${approval.requestId}，${new Date(approval.at).toLocaleTimeString('zh-CN', { hour12: false })}，${approval.codeState ?? '未绑定状态'}）`,
          )
        }
      } else {
        lines.push('- 允许结束放行：无（goal complete 会被拒绝）')
      }
      const goalAllowed = goalApprovals.get(leadId)
      lines.push(
        `- goal 变更批准：${goalAllowed && goalAllowed.size > 0 ? [...goalAllowed].join('、') : '无（edit/pause/blocked 会被拒绝；resume 只能由用户操作）'}`,
      )
    } catch {
      // 忽略 pending 读取失败
    }
    try {
      const legacy = await listCommanderChildren(agent)
      lines.push(`- 历史可续接子agent：${legacy.length > 0 ? legacy.map((row) => row.id).join('、') : '（无）'}`)
    } catch {
      // 忽略历史枚举失败
    }
    const planLatest = newestSections(docs.plan, 1, 600).trim()
    const agentLatest = newestSections(docs.agent, 1, 600).trim()
    lines.push('', '### 最近一轮计划', '', planLatest.length > 0 ? planLatest : '（暂无）')
    lines.push('', '### 最近设计导向', '', agentLatest.length > 0 ? agentLatest : '（暂无）')
    return { text: lines.join('\n'), round: docs.round - 1, goal: goalText, codeState: currentCodeState }
  }

  // ---- 主agent使用的指挥工具 ----
  const commanderTool = {
    name: config.commandToolName,
    description:
      '指挥员模式：一个长期在线、可续接的 Agent Teams teammate（中层设计师 + 督察指挥）。它可以读全盘文件、跑只读 shell、写文件但默认不动手、自行按用户需求决策。' +
      'action=doctor 一条命令自检（PASS/WARN/FAIL + 下一步；fix=true 才纠正权限）；action=checks 运行配置里的受控检查命令（name 省略则列出）；action=start 创建/接管唯一指挥员（仅当没有 goal 时创建一次 goal）；action=list 列出可寻址成员；action=say 发起咨询并登记 requestId（消息里应带本轮汇报：轮次/指令、改动、验证命令与结果、问题/风险、代码版本）；action=wait 无超时等待，返回 decision（继续/需澄清/允许结束）；action=cancel 取消等待；action=status 查看状态。' +
      '只有指挥员明确「允许结束」才允许 complete goal；goal 状态/内容变更需要「批准：goal <动作>」；缺失决定令牌或普通回复都不算放行。' +
      '默认先咨询指挥员再问用户：新任务/阶段开始、完成可验收阶段、遇到取舍时，先 commander say + wait；只有指挥员回「需澄清」或明确要求用户拍板时才 ask_user_question。' +
      '需要用户输入时（选方向/给时间窗/确认不可逆操作）：先 say 说明卡点并请求「暂时作结」，拿到「决定：需澄清」+「批准：goal pause」后暂停 goal、问用户、本轮结束；不要在等用户期间让 goal 继续自动空转。' +
      '指挥员的「继续」按问题大小分流：单点疑问/小 bug 直接答、直接修；方向性/多步工作才按批次连续完成再汇报。工程组/其他多agent仍是执行主体。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'list', 'say', 'wait', 'cancel', 'goal', 'status', 'doctor', 'checks'],
          description: 'start：创建/接管；list：列出成员；say：发咨询；wait：等该请求结束；cancel：取消等待；goal：管理 goal；status：只读状态。',
        },
        message: {
          type: 'string',
          description: 'say 要发给指挥员的完整消息（问题、上下文、需要它判断的取舍）。',
        },
        state: {
          type: 'string',
          enum: ['off', 'observe', 'partial', 'full'],
          description:
            'start 可选的接管状态：默认 partial（部分接管）；用户说「当顾问」用 observe，说「全接管」用 full。',
        },
        requestId: {
          type: 'string',
          description: 'wait/cancel 可选的请求 id；省略时使用当前 pending 请求。',
        },
        goalAction: {
          type: 'string',
          enum: ['create', 'edit', 'pause', 'resume', 'blocked', 'complete', 'clear'],
          description: 'goal 动作；create 需要 objective，edit 可选 objective/maxRounds。',
        },
        objective: {
          type: 'string',
          description: 'goal create/edit 的目标文本。',
        },
        maxRounds: {
          type: 'number',
          description: 'goal create/edit 的轮次上限（可选）。',
        },
        target: {
          type: 'string',
          description: 'say 可选的成员名（默认 commander）。来自 action=list 或 list_agents。',
        },
        name: {
          type: 'string',
          description: 'checks 要运行的检查项名字（来自配置 checkCommands）；省略时列出可用项。',
        },
        fix: {
          type: 'boolean',
          description: 'doctor 专用：为 true 时纠正权限并修剪历史记录（默认只读）。',
        },
      },
      required: ['action'],
    },
    output: {
      schema: COMMANDER_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('dsh-commander: 指挥工具必须由 agent 调用')
      const action = args && typeof args.action === 'string' ? args.action : 'status'
      if (!['start', 'list', 'say', 'wait', 'cancel', 'goal', 'status', 'doctor', 'checks'].includes(action)) {
        throw new Error(
          `dsh-commander: 未知 action "${action}"，只能是 start / list / say / wait / cancel / goal / status / doctor / checks`,
        )
      }
      const signal = exec.signal
      const cwd = await resolveCwd(ctx, agent, signal)
      // 「已咨询」只在真正成功后才置位：失败的 say/goal 不该打开问用户的门禁。
      const markConsulted = () => consultedSinceUser.set(rootSessionIdOf(agent), true)
      if (action === 'status') {
        const status = await commanderStatus(agent, cwd)
        return { action: 'status', text: status.text, docs: [], goal: status.goal }
      }
      if (action === 'doctor') {
        const report = await doctorReport(agent, cwd, { fix: args.fix === true })
        return { action: 'doctor', text: report.text }
      }
      if (action === 'checks') {
        assertRootAgent(agent)
        const name = typeof args.name === 'string' && args.name.trim().length > 0 ? args.name.trim() : undefined
        const result = await runChecks(agent, cwd, name)
        const payload = { action: 'checks', text: result.text }
        if (typeof result.exitCode === 'number') payload.exitCode = result.exitCode
        return payload
      }
      if (action === 'goal') {
        assertRootAgent(agent)
        const goalAction = typeof args.goalAction === 'string' ? args.goalAction : ''
        if (!goalAction) throw new Error('goal 动作需要 goalAction')
        // 指挥员自己管 goal 不必自批；主agent 走这条路必须过同一套门禁，
        // 否则 commander(goal, complete) 就是 update_goal 的后门。
        if (!commanderIds.has(agent.id)) {
          const gate = goalGateError(agent, goalAction)
          if (gate !== undefined) return { action: 'goal', goalAction, text: gate }
        }
        try {
          const result = await applyGoalOperation(agent, goalAction, {
            objective: args.objective,
            maxRounds: typeof args.maxRounds === 'number' ? args.maxRounds : undefined,
            reason: args.message,
          })
          const view = result.goal
          const label = view?.objective ? `${view.objective}（phase=${view.phase}）` : '（已执行）'
          markConsulted()
          return {
            action: 'goal',
            goalAction,
            text: t('goal.opSucceeded', { action: goalAction, label }),
            goal: label,
          }
        } catch (error) {
          return {
            action: 'goal',
            goalAction,
            text: t('goal.opFailed', { action: goalAction, error: error && error.message ? error.message : String(error) }),
          }
        }
      }
      if (action === 'list') {
        const roster = await commanderRoster(agent, signal)
        return { action: 'list', text: roster.text }
      }
      // off（不运行指挥职责）：指挥员在后台睡觉，叫它没用——直接把话回给主agent，让它自己干。
      if (blockedWhenOff(action) && commanderExists(agent) && currentTakeover(agent).state === 'off') {
        return { action, text: t('takeover.offRefusal') }
      }
      assertRootAgent(agent)
      await ensureDocs(cwd, config)
      if (action === 'wait') {
        const result = await waitCommander(agent, typeof args.requestId === 'string' ? args.requestId : undefined, signal)
        const decision = parseDecision(result.text)
        const goalParsed = parseGoalApprovals(result.text)
        const leadId = agent.session?.header?.id ?? agent.id
        const warnings = []
        if (result.kind === 'reply') {
          markConsulted()
          goalApprovals.delete(leadId)
          if (goalParsed.misplaced.length > 0) {
            warnings.push(t('approval.misplaced', { actions: goalParsed.misplaced.join('、') }))
          }
          const failedGoals = []
          for (const goalAction of goalParsed.actions) {
            try {
              const applied = await applyGoalOperation(agent, goalAction, {
                objective: goalParsed.objective,
                maxRounds: goalParsed.maxRounds,
              })
              warnings.push(
                t('goal.applied', { action: goalAction, phase: applied?.goal?.phase ?? 'ok' }),
              )
              if (goalAction === 'pause' || goalAction === 'resume') {
                saveInterruption(leadId, {
                  sessionId: leadId,
                  abnormal: false,
                  goalSource: 'agent',
                  goalAction,
                  at: Date.now(),
                }).catch(() => {})
              }
            } catch (error) {
              failedGoals.push(goalAction)
              warnings.push(t('goal.failed', { action: goalAction, error: error?.message ?? error }))
            }
          }
          if (failedGoals.length > 0) goalApprovals.set(leadId, new Set(failedGoals))
          if (decision === '允许结束') {
            const echoed = parseCodeState(result.text)
            const currentState = await computeCodeState(cwd).catch(() => undefined)
            if (echoed && echoed === result.codeState && currentState === result.codeState) {
              const approval = { requestId: result.requestId, decision, codeState: result.codeState, at: Date.now() }
              approvedSessions.set(leadId, approval)
              await saveApproval(leadId, approval).catch(() => {})
              // 把绑定的值直接摆出来，Lead 复制即可，不用去猜 git hash。
              warnings.push(t('goal.bound', { codeState: result.codeState }))
              try {
                const currentGoal = ctx.get('goals')?.get?.(agent)
                if (currentGoal && currentGoal.phase !== 'complete') {
                  await applyGoalOperation(agent, 'complete')
                  warnings.push(t('goal.released'))
                }
              } catch (error) {
                warnings.push(t('goal.completeFailed', { error: error?.message ?? error }))
              }
            } else {
              approvedSessions.delete(leadId)
              await clearApproval(leadId).catch(() => {})
              if (!echoed) {
                warnings.push(t('goal.releaseRejected.missing'))
              } else if (echoed !== result.codeState) {
                warnings.push(
                  t('goal.releaseRejected.mismatch', { requested: result.codeState, echoed }),
                )
              } else {
                warnings.push(
                  t('goal.releaseRejected.drift', {
                    requested: result.codeState,
                    current: currentState ?? '无法计算',
                  }),
                )
              }
            }
          } else {
            approvedSessions.delete(leadId)
            await clearApproval(leadId).catch(() => {})
          }
          if (decision) {
            await bumpRound(leadId, decision, result.requestId).catch(() => {})
          }
        }
        let text = result.text
        if (result.kind === 'reply') {
          text += decision ? `\n\n决定：${decision}` : `\n\n${t('decision.missing')}`
        }
        if (warnings.length > 0) text += `\n\n${warnings.join('\n')}`
        const payload = { action: 'wait', text, kind: result.kind, target: config.commanderName }
        if (result.requestId) payload.requestId = result.requestId
        if (decision) payload.decision = decision
        return payload
      }
      if (action === 'cancel') {
        const cancelled = await cancelCommander(agent)
        const payload = {
          action: 'cancel',
          text: cancelled.cancelled
            ? t('cancel.done', { requestId: cancelled.requestId })
            : t('cancel.none'),
        }
        if (cancelled.requestId) payload.requestId = cancelled.requestId
        return payload
      }
      if (action === 'start') {
        const leadId = rootSessionIdOf(agent)
        const stateBefore = currentTakeover(agent).state
        const goalMessage = await applyGoalPolicy(agent)
        const docs = await readDocsState(cwd, config)
        let goal
        try {
          goal = ctx.get('goals')?.get?.(agent)
        } catch {
          goal = undefined
        }
        const { member, created } = await ensureCommanderTeammate(agent, cwd, docs, goal, signal)
        // 启动即初始化：新建的指挥员按「用户指定 > 默认 partial」进场；
        // 已存在但正处在 off（睡觉）的，这次 start 就是把它叫醒回到职责。
        //
        // state 参数只在**真的新建**时生效：否则主agent 可以 start(state="observe")
        // 把自己从全接管里放出来，门禁就成了摆设。
        const requestedState = created ? normalizeTakeover(args.state) : undefined
        if (requestedState) await setTakeoverOverride(leadId, requestedState, 'init')
        else if (created || stateBefore === 'off') await setTakeoverOverride(leadId, DEFAULT_TAKEOVER, 'init')
        // 启动也是一次状态落定：告诉主agent 现在按哪个宽度接管。
        announceTakeover(leadId, currentTakeover(agent).state)
        const modelNote = await applyAdvisorModel(member.id)
        const titleNote = await applyCommanderTitle(member.id)
        const lines = [
          created ? '## ' + t('start.created') : '## ' + t('start.ready'),
          '',
          `- target：\`${member.name}\`（session=${member.id}，status=${member.status ?? 'provisioning'}）`,
          `- 会话标题：${titleNote?.title ? titleNote.title : titleNote?.error ? t('start.titleSkipped') : '（未配置）'}`,
          `- 指导者模型：${
            modelNote?.selected
              ? `${modelNote.selected.provider}/${modelNote.selected.model}`
              : modelNote?.error
                ? `${t('start.modelFallback')}（${modelNote.error}）`
                : t('start.modelFallback')
          }`,
          `- goal：${goalMessage || t('goal.kept')}`,
          `- ${t('label.takeover')}：${takeoverLine(agent)}`,
          `- 文档：${DOC_FILES.map((key) => `doc/${key}.md`).join('、')}`,
          '',
          `用 \`commander(action=say, message="...")\` 发起咨询，再 \`commander(action=wait)\` 无超时等待；也可直接 \`send_message({ target: "${member.name}", ... })\`（不登记 pending）。`,
        ]
        return { action: 'start', text: lines.join('\n'), target: member.name, docs: [], goal: goalMessage }
      }

      const message =
        typeof args.message === 'string' && args.message.trim().length > 0
          ? args.message.trim()
          : '请给出当前完成状况、项目整体目的与下一步具体建议。'
      const target = typeof args.target === 'string' && args.target.trim().length > 0 ? args.target.trim() : undefined
      const sent = await sendToCommander(agent, target, message, signal, cwd)
      markConsulted()
      return {
        action: 'say',
        text:
          t('say.sent', { target: sent.target, requestId: sent.requestId }) +
          `\n${t('say.next')}` +
          `\n${t('say.report')}`,
        target: sent.target,
        requestId: sent.requestId,
      }
    },
  }

  // ---- 主agent记录行动历史的工具 ----
  const recordTool = {
    name: config.recordToolName,
    description:
      '把主agent刚完成的实质行为倒序（最新在上）追加到 doc/history.md，供下一轮指挥员判断进度。每完成一段实质工作后调用一次；只记录事实，不要写计划或建议。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        summary: {
          type: 'string',
          description: '一句话概括本轮完成的行为（例如“修复登录接口 500，并通过 auth 测试”）。',
        },
        details: {
          type: 'string',
          description: '可选补充细节（Markdown）：改动的文件、验证方式、遗留问题。',
        },
      },
      required: ['summary'],
    },
    output: {
      schema: RECORD_OUTPUT_SCHEMA,
      render: (_args, value) => [
        { type: 'text', text: `已写入 ${value.path}（最新在上）\n\n${value.summary}` },
      ],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('dsh-commander: 记录工具必须由 agent 调用')
      const summary = oneLine(args?.summary)
      if (summary.length === 0) throw new Error('dsh-commander: summary 不能为空')
      const details = typeof args?.details === 'string' ? args.details : ''
      const cwd = await resolveCwd(ctx, agent, exec.signal)
      const paths = await ensureDocs(cwd, config)
      await prependEntry(paths.history, DOC_HEADERS.history, formatHistoryEntry(summary, details))
      return { path: path.relative(cwd, paths.history).split(path.sep).join('/'), summary }
    },
  }

  // ---- 斜杠命令：/<commandName> ----
  const COMMAND_USAGE = [
    t('help.usage1', { cmd: config.commandName }),
    t('help.usage2', { cmd: config.commandName }),
    t('help.empty', { cmd: config.commandName }),
  ].join('\n')

  const COMMAND_VERBS = ['start', 'list', 'status', 'doctor', 'checks', 'takeover', 'say', 'ask', 'round', 'wait', 'cancel', 'record', 'help']
  const COMMAND_ALIASES = new Map([
    ['启动', 'start'], ['开始', 'start'],
    ['列表', 'list'], ['状态', 'status'],
    ['说', 'say'], ['问', 'say'],
    ['等待', 'wait'], ['取消', 'cancel'],
    ['记录', 'record'], ['帮助', 'help'], ['说明', 'help'],
    ['自检', 'doctor'], ['体检', 'doctor'], ['检查', 'checks'],
    ['接管', 'takeover'], ['指挥', 'takeover'],
  ])

  /** 编辑距离（含相邻换位），只用于给拼错的子命令一个提示。 */
  function editDistance(a, b) {
    const rows = []
    for (let i = 0; i <= a.length; i += 1) {
      const row = new Array(b.length + 1).fill(0)
      row[0] = i
      rows.push(row)
    }
    for (let j = 0; j <= b.length; j += 1) rows[0][j] = j
    for (let i = 1; i <= a.length; i += 1) {
      for (let j = 1; j <= b.length; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1
        rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost)
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1)
        }
      }
    }
    return rows[a.length][b.length]
  }

  /** 找出最接近的已知子命令（拼错时提示，不当成消息发出去）。 */
  function suggestVerb(word) {
    let best
    for (const verb of COMMAND_VERBS) {
      const distance = editDistance(word, verb)
      const prefix = word.length >= 3 && verb.startsWith(word)
      if (distance <= 1 || prefix) {
        if (!best || distance < best.distance) best = { verb, distance }
      }
    }
    return best?.verb
  }

  /**
   * 解析斜杠命令参数：已知子命令照旧；否则整段当消息发给指挥员。
   * 只有「看起来像英文子命令但拼错」时才报错，避免把中文需求误判成命令。
   */
  function resolveCommandInput(raw) {
    const trimmed = String(raw ?? '').trim()
    // 空参数只显示用法：/commander 不带参数时不应该创建指挥员和 goal。
    if (trimmed.length === 0) return { verb: 'help', rest: '' }
    const parts = trimmed.split(/\s+/)
    const first = parts[0]
    const rest = parts.slice(1).join(' ').trim()
    const lower = first.toLowerCase()
    if (COMMAND_VERBS.includes(lower)) return { verb: lower, rest }
    const alias = COMMAND_ALIASES.get(first)
    if (alias) return { verb: alias, rest }
    if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(first)) {
      const guess = suggestVerb(lower)
      if (guess) return { verb: 'unknown', raw: first, suggestion: guess, rest: '' }
    }
    return { verb: 'say', rest: trimmed, implicit: true }
  }

  /** 确保文档、goal 与指挥员 teammate 都就绪；start / say 共用。 */
  async function ensureCommanderReady(agent, signal, options = {}) {
    const cwd = await resolveCwd(ctx, agent, signal)
    await ensureDocs(cwd, config)
    const goalMessage = await applyGoalPolicy(agent, options.commandStart ? { commandStart: true } : {})
    const docs = await readDocsState(cwd, config)
    let goal
    try {
      goal = ctx.get('goals')?.get?.(agent)
    } catch {
      goal = undefined
    }
    const { member, created } = await ensureCommanderTeammate(agent, cwd, docs, goal, signal)
    return { cwd, member, created, goalMessage }
  }

  async function handleCommanderCommand(invocation) {
    const agent = invocation.agent
    const signal = invocation.signal
    const raw = String(invocation.rawInput ?? '').trim()
    const resolved = resolveCommandInput(raw)
    const verb = resolved.verb
    const rest = resolved.rest ?? ''
    try {
      if (verb === 'unknown') {
        return {
          kind: 'error',
          text:
            `${t('command.unknownVerb', { raw: resolved.raw, suggestion: resolved.suggestion })}\n` +
            `直接跟需求也可以：\`/${config.commandName} <你的问题或任务>\`\n${COMMAND_USAGE}`,
        }
      }
      if (verb === 'start') {
        assertRootAgent(agent)
        const { cwd, member, created, goalMessage } = await ensureCommanderReady(agent, signal, { commandStart: true })
        const lines = [
          created ? '## ' + t('start.created') : '## ' + t('start.ready'),
          '',
          `- target：\`${member.name}\`（session=${member.id}，status=${member.status ?? 'provisioning'}）`,
          `- goal：${goalMessage}`,
          '- 这是一个可续接的 teammate：后续用 `send_message` 或 `commander(action=say)` 对话，不会新建卡片。',
          '- 它可以读全部文件、跑只读 shell、直接向用户提问；写文件/编译会被拒绝。',
          `- 直接把需求写在命令后面即可：\`/${config.commandName} <你的问题或任务>\`。`,
        ]
        return { kind: 'success', text: lines.join('\n') }
      }
      if (verb === 'list') {
        const roster = await commanderRoster(agent, signal)
        return { kind: 'success', text: roster.text }
      }
      if (verb === 'status') {
        const cwd = await resolveCwd(ctx, agent, signal)
        const status = await commanderStatus(agent, cwd)
        return { kind: 'success', text: status.text }
      }
      if (verb === 'doctor') {
        const cwd = await resolveCwd(ctx, agent, signal)
        const fix = /\bfix\b|--fix/.test(rest)
        const report = await doctorReport(agent, cwd, { fix })
        return { kind: report.fails > 0 ? 'error' : 'success', text: report.text }
      }
      if (verb === 'takeover') {
        assertRootAgent(agent)
        const leadId = rootSessionIdOf(agent)
        const requested = rest.length > 0 ? rest.split(/\s+/)[0] : ''
        if (requested.length === 0) {
          const { state, source } = currentTakeover(agent)
          return {
            kind: 'success',
            text:
              `接管状态：${takeoverLine(agent)}\n` +
              `可选：${TAKEOVER_STATES.join(' / ')}；用 \`/${config.commandName} takeover <状态>\` 切换。\n` +
              `- off 不运行指挥职责：指挥员休息，commander say/wait 直接拒绝，门禁全关\n` +
              `- observe 不接管：指挥员只当顾问\n` +
              `- partial 部分接管：goal 命令与放行归指挥员（启动默认）\n` +
              `- full 全接管：连问用户都要先过指挥员（你不在场时用）`,
          }
        }
        if (requested === 'reset' || requested === 'auto') {
          await setTakeoverOverride(leadId, undefined)
          return { kind: 'success', text: `已清除覆盖，接管状态回到推导值：${takeoverLine(agent)}` }
        }
        const normalized = normalizeTakeover(requested)
        if (!normalized) {
          return {
            kind: 'error',
            text: `未知接管状态 "${requested}"；可选：${TAKEOVER_STATES.join(' / ')}，或 reset 回到推导值。`,
          }
        }
        await setTakeoverOverride(leadId, normalized)
        return {
          kind: 'success',
          text: `接管状态已设为：${TAKEOVER_LABELS[normalized]}（${normalized}）。${takeoverLine(agent)}`,
        }
      }
      if (verb === 'checks') {
        assertRootAgent(agent)
        const cwd = await resolveCwd(ctx, agent, signal)
        const result = await runChecks(agent, cwd, rest.length > 0 ? rest.split(/\s+/)[0] : undefined)
        return { kind: result.kind === 'fail' || result.kind === 'timeout' ? 'error' : 'success', text: result.text }
      }
      if (verb === 'say' || verb === 'ask' || verb === 'round') {
        assertRootAgent(agent)
        const message = rest.length > 0 ? rest : '请给出当前完成状况、项目整体目的与下一步具体建议。'
        // 直接 `/commander <需求>` 时指挥员可能还没创建：这里先补齐，再投递。
        const { cwd } = await ensureCommanderReady(agent, signal)
        const sent = await sendToCommander(agent, undefined, message, signal, cwd)
        const head = resolved.implicit
          ? t('say.sentImplicit', { target: sent.target, requestId: sent.requestId })
          : t('say.sent', { target: sent.target, requestId: sent.requestId })
        return {
          kind: 'success',
          text: `${head}\n用 \`/${config.commandName} wait\` 无超时等待；其他完成事件会临时返回，验收后再 wait。\n\n${message}`,
        }
      }
      if (verb === 'wait') {
        assertRootAgent(agent)
        const result = await waitCommander(agent, rest.length > 0 ? rest : undefined, signal)
        return { kind: 'success', text: result.text }
      }
      if (verb === 'cancel') {
        assertRootAgent(agent)
        const cancelled = await cancelCommander(agent)
        return {
          kind: 'success',
          text: cancelled.cancelled ? t('cancel.done', { requestId: cancelled.requestId }) : t('cancel.none'),
        }
      }
      if (verb === 'record') {
        if (rest.length === 0) return { kind: 'error', text: `${t('command.recordMissing')}${COMMAND_USAGE}` }
        const cwd = await resolveCwd(ctx, agent, signal)
        const paths = await ensureDocs(cwd, config)
        await prependEntry(paths.history, DOC_HEADERS.history, formatHistoryEntry(rest, ''))
        return {
          kind: 'success',
          text: `已写入 ${path.relative(cwd, paths.history).split(path.sep).join('/')}（最新在上）\n\n${rest}`,
        }
      }
      if (verb === 'help') return { kind: 'success', text: COMMAND_USAGE }
      return { kind: 'error', text: `${t('command.unknownArg', { raw })}${COMMAND_USAGE}` }
    } catch (error) {
      return {
        kind: 'error',
        text: t('command.failed', { error: error && error.message ? error.message : String(error) }),
      }
    }
  }

  ctx.inject(['commands'], (commandsCtx) => {
    commandsCtx.commands.register({
      name: config.commandName,
      description: '指挥员模式：直接跟需求（/commander <需求>）即发给指挥员；也可 start / list / status / say / wait / cancel / record / help。同一会话复用一个 teammate，不新建卡片。',
      input: { hint: '<需求或问题> | start | status | wait | cancel | record <summary>' },
      handler: (invocation) => handleCommanderCommand(invocation),
    })
  })

  ctx.effect(() => {
    const disposeCommander = ctx.tools.register(commanderTool)
    const disposeRecord = ctx.tools.register(recordTool)
    return () => {
      disposeCommander()
      disposeRecord()
    }
  })

  // 接管状态：只在内存里（启动时按口径初始化，不沿用上次进程的旧值）；再挂一个
  // 只读/可写的 HTTP 路由给客户端图标。
  //
  // 用 handler 而不是 resource：宿主的 resource 路由只接受 GET/HEAD，POST 会被直接
  // 405 掉，而图标点击需要写状态。
  // 必须用 ctx.inject 等 webServer 就位：直接 ctx.get 时插件加载顺序不同就会拿到
  // undefined，然后 return 掉再也不注册（vps 上就是这么 404 的）。
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.get('webServer')
    if (!webServer || typeof webServer.register !== 'function') return
    webCtx.effect(() => {
    const sendJson = (res, body, status = 200) => {
      const payload = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(payload),
      })
      res.end(payload)
    }
    /** 状态标签随语言一起下发，客户端不用自己维护一份文案。 */
    const stateLabels = () => Object.fromEntries(TAKEOVER_STATES.map((state) => [state, t('takeover.' + state)]))
    const readBody = (req) =>
      new Promise((resolveBody) => {
        let data = ''
        req.on('data', (chunk) => {
          data += chunk
          if (data.length > 8192) req.destroy()
        })
        req.on('end', () => resolveBody(data))
        req.on('error', () => resolveBody(''))
      })
    /** 从图标点进来的启动：只负责把指挥员拉起来，不碰 goal 策略。 */
    const startCommanderFromUi = async (agent) => {
      const cwd = await resolveCwd(ctx, agent, undefined)
      const docs = await readDocsState(cwd, config)
      let goal
      try {
        goal = ctx.get('goals')?.get?.(agent)
      } catch {
        goal = undefined
      }
      return ensureCommanderTeammate(agent, cwd, docs, goal, undefined)
    }
    return webServer.register({
      kind: 'prefix',
      path: '/commander/takeover',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        let sessionId = url.searchParams.get('sessionId') ?? ''
        let payload
        if (req.method === 'POST') {
          const raw = await readBody(req)
          try {
            payload = raw.length > 0 ? JSON.parse(raw) : {}
          } catch {
            return sendJson(res, { error: 'invalid json' }, 400)
          }
          if (typeof payload?.sessionId === 'string' && payload.sessionId.length > 0) {
            sessionId = payload.sessionId
          }
        }
        if (!sessionId) return sendJson(res, { error: 'sessionId required' }, 400)
        const agent = ctx.get('agents')?.get?.(sessionId)
        const hasCommander = agent ? commanderExists(agent) : false
        const current = agent
          ? currentTakeover(agent)
          : resolveTakeover({ hasCommander: false, override: takeoverOverrides.get(sessionId)?.state })
        if (req.method === 'GET' || req.method === 'HEAD') {
          return sendJson(res, {
            state: current.state,
            source: current.source,
            label: TAKEOVER_LABELS[current.state] ?? current.state,
            states: TAKEOVER_STATES,
            labels: stateLabels(),
            hasCommander,
          })
        }
        if (req.method === 'POST') {
          const requested = payload?.state === 'next' ? nextTakeover(current.state) : payload?.state
          const normalized = normalizeTakeover(requested)
          if (!normalized) return sendJson(res, { error: 'invalid state', states: TAKEOVER_STATES, labels: stateLabels() }, 400)
          // 选了一个「运行职责」的状态、而指挥员还没起来 → 顺手把它启动起来。
          // 这正是菜单作为入口的意义：点哪个状态，指挥员就以那个状态进场。
          let started = false
          if (normalized !== 'off' && agent && !hasCommander) {
            try {
              await startCommanderFromUi(agent)
              started = true
            } catch (error) {
              return sendJson(
                res,
                {
                  error: 'start failed',
                  message: error && error.message ? error.message : String(error),
                  state: current.state,
                  source: current.source,
                  label: TAKEOVER_LABELS[current.state] ?? current.state,
                  states: TAKEOVER_STATES,
                  labels: stateLabels(),
                  hasCommander: false,
                },
                500,
              )
            }
          }
          await setTakeoverOverride(sessionId, normalized)
          // 用户点了图标就是做了决定：写一条 developer 消息，主agent 下一轮就知道。
          // 状态没变就不写，免得反复点同一个选项刷屏。
          const announced = normalized === current.state ? false : announceTakeover(sessionId, normalized)
          // 重新设定接管状态 = 显式要求重新开始，把「停运/让位」清掉。
          const handoff = handoffStates.get(sessionId)
          if (handoff !== undefined) {
            handoff.stopped = false
            handoff.interrupted = false
            handoff.turnEnded = false
          }
          return sendJson(res, {
            state: normalized,
            source: 'user',
            label: TAKEOVER_LABELS[normalized] ?? normalized,
            states: TAKEOVER_STATES,
            labels: stateLabels(),
            hasCommander: started ? true : hasCommander,
            started,
            announced,
          })
        }
        return sendJson(res, { error: 'method not allowed' }, 405)
      },
      })
    })
  })
}
