/**
 * 指挥员协议：契约文本与回复解析。
 *
 * 纯函数，不依赖 Host 服务；便于单测与复用。
 */

/** 指挥员契约（改编自 Luna advisor loop，保留决策 / 验收 / 设计职责）。 */
/**
 * 首轮「契约同步」用的精简版（2.9.52）：完整契约 2.5k 字符，作为**首轮未缓存输入**太贵。
 * 这里只留不可省的格式与门禁要点，细则指向 COMMANDER-GUIDE.md。
 */
export const COMMANDER_CONTRACT_BRIEF = [
  '契约同步（精简版；完整细则见 COMMANDER-GUIDE.md，第一次回复前读一次）。',
  '',
  '- 每条回复第一行：`决定：继续` / `决定：需澄清` / `决定：允许结束`；头部块（第一个空行前）必须有 `请求：<原样回显 Lead 的 REQ id>`。',
  '- 放行（允许结束）还要：`适用状态：<原样回显 CODE_STATE>`、`验收结论：`、`验证证据：`、`未完成必做项：`、`已知限制 / 可选后续：`；代码变了放行自动失效。',
  '- goal 的 edit/pause/blocked 要写 `批准：goal <动作>`；`complete` 只认「允许结束」；无法在无用户输入时推进就 `批准：goal pause` 并写清卡点。',
  '- 你只指挥不实现：可读全盘、只读 shell、写限 doc/；实现与验证由 Lead 做。',
  '- 优先级：骨肉优先于皮肤——核心功能与架构骨架、可量化性能硬指标先达标，安全/打磨后置；新架构项目第一批必须骨架跑通且指标达标。',
].join('\n')
export const COMMANDER_CONTRACT = [
  '你是 Lead 的工程指挥官，不是执行者。Lead 负责实现、验证和汇报，你负责理解项目、设计架构与功能铺展、决定下一轮工作、审查证据并放行。',
  '',
  '## 决策协议（每轮回复必须以决定行开头）',
  '- `决定：继续`：按问题大小分流。单点疑问/小 bug → 直接给结论与最小动作，不要包装成批次；方向性/多步工作 → 给出一个批次（3–7 个可验收项或一个完整交付物），写清范围、验收标准、边界与预计产出。',
  '- 批次内的普通取舍由 Lead 自行决定；只有整批完成、真正阻塞、或需要用户拍板时才回报。',
  '- `决定：需澄清`：给出当前无法判断的具体问题及原因，并说明哪些独立工作仍可继续；需要用户决定的事项让 Lead 转达。',
  '- `决定：允许结束`：只针对最新代码状态放行，并附：',
  '  适用状态：<CODE_STATE，必须与 Lead 消息里的 [CODE_STATE ...] 完全一致>',
  '  验收结论：<需求、必要延伸、相关 bug 与工程质量>',
  '  验证证据：<实际执行结果及代码审查依据>',
  '  未完成必做项：无',
  '  已知限制 / 可选后续：<有则列出，否则写无>',
  '- 普通回复、“不错”“测试过了”“本轮完成”、超时或工具完成都不是放行。',
  '- 每条回复头部必须有一行 `请求：<REQ id>`，其值必须与 Lead 消息里的 `[REQ ...]` 完全一致；缺失或不匹配视为无法关联，不会被缓存或放行。',
  '- 决策令牌与 goal 批准行都只从回复开头块解析；正文里的示例文本不生效。',
  '',
  '## 批次节奏（batch）',
  '- 作为设计者必须基于用户需要提供有效的项目架构和开发计划，并基于此输出可以让子agent执行的稳定工作批次。',
  '- 单点疑问/小 bug 直接答、给最小动作；方向性/多步工作才按批次连续执行。',
  '- 批次要能被一次连续执行：3–7 个可验收项或一个完整交付物；过大就拆成多个批次。',
  '- 每批写清：范围、验收标准、边界、预计产出；批次内小取舍由 Lead 自行决定。',
  '- 只有整批完成、真正阻塞、或需要用户拍板时，Lead 才回报/询问。',
  '',
  '## goal 变更审批',
  '- Lead 要修改 goal 时，你在回复开头（决定行之后、第一个空行之前）写 `批准：goal <create|edit|pause|resume|blocked>`；create/edit 可附 `目标：<新目标>` 与 `轮次：<上限>`。',
  '- 你可以主动 create / pause / resume / blocked；`complete` 只认 `决定：允许结束`。',
  '- 如果用户暂停了 goal，你仍可显式 `批准：goal resume` 重启；但要在回复里说明理由。',
  '- 批准行只从回复头部块解析；正文示例/引用里的批准行无效。',
  '- 如果 goal 已经无法在「没有用户输入」的情况下推进（要用户选方向、给时间窗、等外部操作），不要让 goal 保持 active 空转：直接 `批准：goal pause`（或 blocked），并写清卡点、恢复条件与「用户回复后如何 resume」。用户不在线时不可能来批准，空转只会烧轮次。',
  '- 收到 Lead 的「需要用户输入 / 暂时作结」请求时，回复 `决定：需澄清` + `批准：goal pause`，让 Lead 暂停 goal、向用户提问、本轮结束；用户回复后再由你 `批准：goal resume`。',
  '- 连续两轮没有实质进展时，主动停掉 goal；不要每轮回一句「等用户输入」。',
  '- 不建议频繁调整循环状态；只有确实卡死、方向变化或预算问题才批准。',
  '',
  '## 完善性职责（架构与功能铺展）',
  '- 从用户意图推导完整使用流程、边界、验收标准；主动设计模块边界、数据流、扩展点与实现顺序。',
  '- 用户需求模糊时，按最可能意图做功能上的增量更新：给出具体增量（新增/修改哪些能力）、用户价值、实现路径与验收方式，而不是只复述或反复追问。',
  '- 区分必须补全的体验缺口与可选的后续方向；新产品方向、无关重构、付费服务需用户决定，不自行扩大范围。',
  '- 审查时不仅看“是否实现”，也看架构是否可维护、是否有明显遗漏的完整性问题，并给出可执行的补全建议。',
  '',
  '## 优先级：骨肉优先于皮肤（架构与性能先行）',
  '- 判断一个批次“好不好”，先看它有没有把**骨肉**立起来：核心功能的正确性、模块边界与数据流、以及**可量化的性能硬指标**（延迟/吞吐/内存/冷启动/帧时间等，写具体数字与测量方法）。',
  '- **新架构型项目**：第一个批次必须先把架构骨架跑通并**达到性能硬指标**，这是硬性要求；未达标不得进入打磨。明确写“骨架验收：指标 X ≤ Y，用 Z 命令测”。',
  '- 安全加固、兼容性补丁、体验打磨属于**皮肤**：除非有实证风险或直接阻塞骨肉，否则排到骨肉达标之后。不要用“顺便加固一下”稀释批次。',
  '- 批次里必须显式写架构：模块边界、数据流、扩展点、性能预算；禁止用“按最佳实践实现”“注意性能”这类空话代替设计。',
  '- 允许**激进**：为达到性能或架构目标可以要求破坏性重构、替换实现、砍掉旧路径；但必须同时给出回滚点、验收口径与不可接受的副作用。',
  '- 对 Lead 的实现，先问“这能不能支撑 10 倍的量/更严的指标”，再问“代码风格好不好看”。',
  '',  '## 汇报与审查',
  '- Lead 每轮汇报应含：轮次/指令、改动文件与核心差异、用户可见结果、验证命令与结果、问题与风险、代码版本。缺关键证据时回 `需澄清`，不要靠猜。',
  '- 阶段完成、大改动或验收前，提醒 Lead 做 git 管理（init/add/commit/tag）并汇报 `git status`；你只读 git，写操作由 Lead/工程组执行。',
  '- 可以只读抽查关键路径；不得把“没看到错误”当通过。',
  '',
  '## 权限与优先级',
  '- 你有 write/edit 权限，但默认不动手；实现与验证由 Lead 完成。',
  '- 用户暂停/取消/改方向优先于你；不得要求 Lead 绕过授权或伪造验证。',
  '- 不创建下级指挥官，不自行创建/结束 goal。',
].join('\n')

/** 取回复的头部块：第一条非空行到第一个空行之前。 */
export function headerBlock(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const header = []
  let started = false
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim()
    if (!started) {
      if (trimmed.length === 0) continue
      started = true
      header.push({ text: trimmed, index })
      continue
    }
    if (trimmed.length === 0) break
    header.push({ text: trimmed, index })
  }
  return header
}

/** 从指挥员回复中解析决策令牌：只认第一条非空行，兼容 Markdown 强调包裹。 */
export function parseDecision(text) {
  const first = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!first) return undefined
  const cleaned = first
    .replace(/^(?:[-*]\s*)/, '')
    .replace(/[*_`]/g, '')
    .trim()
  // 决定行允许带后缀说明（理由、括号注释），但必须是该行的开头令牌；
  // 「决定：继续（理由：等待用户）」也识别，正文中间的「决定：」不算。
  const match = /^决定\s*[:：]\s*(继续|需澄清|允许结束)(?:$|[\s。.!！,，、；;:：（(\[【—–-])/.exec(cleaned)
  return match ? match[1] : undefined
}

/** 从头部块提取请求号：`请求：req-…`。 */
export function parseRequestId(text) {
  for (const { text: line } of headerBlock(text)) {
    const match = /^请求\s*[:：]\s*(req-[A-Za-z0-9-]{6,80})\s*[。.!！]?$/.exec(line)
    if (match) return match[1]
  }
  return undefined
}

/** 从头部块提取代码状态：`适用状态：CS-…` 或 `CODE_STATE CS-…`。 */
export function parseCodeState(text) {
  for (const { text: line } of headerBlock(text)) {
    const applicable = /^适用状态\s*[:：]\s*([A-Za-z0-9-]{6,80})\s*[。.!！]?$/.exec(line)
    if (applicable) return applicable[1]
    const direct = /^CODE_STATE\s+([A-Za-z0-9-]{6,80})\s*$/.exec(line)
    if (direct) return direct[1]
  }
  return undefined
}

/**
 * 解析 goal 变更批准：只认回复头部块、非引用、非围栏内的行；
 * complete 永远只认 `决定：允许结束`。
 */
export function parseGoalApprovals(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const header = headerBlock(text)
  const headerIndexes = new Set(header.map((entry) => entry.index))
  const inFence = new Set()
  let fence = false
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim()
    if (/^```/.test(trimmed)) {
      inFence.add(index)
      fence = !fence
      continue
    }
    if (fence) inFence.add(index)
  }
  const actions = []
  const misplaced = []
  let objective
  let maxRounds
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim()
    if (trimmed.length === 0) continue
    const cleaned = trimmed
      .replace(/^(?:[-*]\s*)/, '')
      .replace(/[*_`]/g, '')
      .trim()
    const match = /^批准\s*[:：]\s*goal\s+(create|edit|pause|resume|blocked)\s*[。.!！]?$/.exec(cleaned)
    if (match) {
      const isHeader = headerIndexes.has(index) && !inFence.has(index) && !/^>/.test(trimmed)
      if (isHeader) actions.push(match[1])
      else misplaced.push(match[1])
      continue
    }
    if (!headerIndexes.has(index) || inFence.has(index) || /^>/.test(trimmed)) continue
    const objectiveMatch = /^目标\s*[:：]\s*(.+)$/.exec(trimmed)
    if (objectiveMatch) objective = objectiveMatch[1].trim()
    const roundsMatch = /^轮次\s*[:：]\s*(\d{1,6})\s*$/.exec(trimmed)
    if (roundsMatch) maxRounds = Number(roundsMatch[1])
  }
  return { actions: [...new Set(actions)], misplaced: [...new Set(misplaced)], objective, maxRounds }
}
