/**
 * 主agent 说明书（单一事实源）。
 *
 * 为什么单独一个模块：
 *   - 工具 description 只能放「是什么 + 动作清单 + 硬门禁」，塞不下完整协议；
 *   - 但新装的 agent 必须能**按需**拿到完整流程，否则只能靠猜（这轮踩过的坑都在这）。
 *
 * 用法：
 *   commander(action="help")               → 索引（每个 topic 一行 + 什么时候该看）
 *   commander(action="help", topic="loop") → 该段正文
 *
 * 约束：
 *   - 纯数据 + 纯函数，无宿主依赖、无时间戳，便于单测与生成 `AGENT-MANUAL.md`；
 *   - 中文单语：契约令牌（决定/批准/允许结束）本身就是中文，说明书跟协议走；
 *   - 只写「怎么用」，不写实现细节；具体报错以工具返回为准。
 */

/**
 * 主agent看到的工具说明（常驻上下文，越短越好）。
 *
 * 只放「是什么 + 动作清单 + 硬门禁 + 指路」，完整协议在本文件的 topic 里
 * （`commander(action="help")`）。长度由 `test/manual.mjs` 卡在 800 字符内。
 */
export const COMMANDER_TOOL_DESCRIPTION =
  '指挥员模式：一个长期在线、可续接的 Agent Teams teammate（中层设计师 + 督察指挥），能读全盘文件、跑只读 shell、写 doc 但默认不动手。' +
  'action：start 创建/接管；list 列出成员；say 发起咨询并登记 requestId；wait 无超时等待；cancel 取消等待；goal 管理 goal；status 只读状态；doctor 自检；checks 跑受控检查；handoff 交接探针；help 取说明书（topic 可选）。' +
  '硬门禁：只有指挥员明确「允许结束」才能 complete goal；goal 的 complete/edit/pause/blocked 需要「批准：goal <动作>」；全接管下问用户之前必须先 say + wait。' +
  '不确定怎么用就先 commander(action="help")。'

/** 说明书分段。顺序即索引顺序，也是 AGENT-MANUAL.md 的章节顺序。 */
export const MANUAL_TOPICS = [
  {
    id: 'overview',
    title: '它是什么、不是什么',
    when: '第一次用、或不确定该不该找它',
    body: [
      '指挥员是一个长期在线、可续接的 teammate：中层设计师 + 督察指挥。它读全盘文件、跑只读 shell、能写 doc 但默认不动手。',
      '',
      '- **它给方向与验收，不写实现**：判断「现在到哪了、下一步做什么、这轮算不算过」。实现由你或工程组做。',
      '- **它不是用户代理**：用户随时能插话、能改接管状态；它的「继续」不等于用户点头（要看接管状态）。',
      '- **一个会话只有一个**，跨轮次复用；`action="start"` 只创建/接管，不会每轮新建卡片。',
      '- 它是可续接的：新会话里也能用 `action="list"` 找到历史成员并 `action="say", target="<id>"` 续接。',
    ].join('\n'),
  },
  {
    id: 'states',
    title: '接管四态：谁握着方向盘',
    when: '判断「这一步能不能直接问用户 / 能不能自己结束 goal」',
    body: [
      '用户在界面图标里选状态，**你改不了**（没有 action 能改）。四种状态决定哪些门禁生效：',
      '',
      '| 状态 | 含义 | 问用户 | goal 的 complete/edit/pause/blocked | 每轮自动交接 |',
      '| --- | --- | --- | --- | --- |',
      '| `off` 不运行指挥职责 | 指挥员休息 | 自由 | 自由 | 否 |',
      '| `observe` 不接管 | 只当顾问 | 自由 | 自由 | 否 |',
      '| `partial` 部分接管（**默认**） | 接管 goal 与放行 | 自由 | 需要批准 | 否 |',
      '| `full` 全接管 | 你不在场，指挥员代言 | **必须先 say + wait** | 需要批准 | **是** |',
      '',
      '- `off` 下 `say` / `wait` 会被拒绝并提示「用户已切换至不指挥状态」——那时自己判断推进，不要反复试。',
      '- 状态只在内存里：**插件重载或进程重启会回到 `partial`**。用户可能因此意外「恢复」了指挥，别当成 bug。',
      '- 不确定当前状态：`action="status"` 第一屏就有。',
    ].join('\n'),
  },
  {
    id: 'loop',
    title: '一轮怎么走：say → wait → 分流',
    when: '准备发起一次咨询，或拿到回复后不知道下一步',
    body: [
      '标准循环（`partial` / `full` 都适用）：',
      '',
      '1. **什么时候报**：新任务或新阶段开始时、完成一个可验收阶段时、遇到真正需要取舍的分叉时。不要每改一行就报。',
      '2. `commander(action="say", message=汇报)` → 返回 requestId，进入等待。',
      '3. `commander(action="wait")` 无超时等待。返回 `interrupt` 表示有工程组/子agent 完成：**只验收它已完成的工作**，不要分发新工作，然后再次 `wait` 等同一个请求。',
      '4. 按回复头部的 `决定：` 分流：',
      '   - `继续` → 直接做。单点疑问/小 bug 直接答、直接修；方向性/多步工作按批次连续做完再汇报。',
      '   - `需澄清` → 这时才允许 `ask_user_question`（或按它指出的缺口去补信息）。',
      '   - `允许结束` → 才可 `update_goal complete`；若插件已代执行（返回 `goal.applied`），不要再调。',
      '',
      '一次只挂一个请求：`pending.exists` 表示还有未完成的请求，先 `wait` 或 `cancel`，不要并发 `say`。',
    ].join('\n'),
  },
  {
    id: 'tokens',
    title: '契约令牌与批准行（放行靠它）',
    when: '回复被判无效、放行不生效、或想知道怎么写批准',
    body: [
      '指挥员的回复头部块（**第一个空行之前**）是唯一被解析的区域：',
      '',
      '```',
      '决定：继续 | 需澄清 | 允许结束',
      '批准：goal complete        ← 需要批准时才写，必须紧跟在决定行之后',
      '请求：req-…                ← 回显请求号，缺了不会关联上',
      '适用状态：CS-…             ← 放行必须原样回显这个代码状态',
      '```',
      '',
      '- 缺 `决定：` 令牌 = 无效回复（工具会提示「缺少决定令牌」）。',
      '- 批准行跑到正文里 = 失效（会提示「批准行不在回复头部块」）。',
      '- 放行绑代码状态：请求之后你改过代码，放行就作废（会明确说 requested/current 不一致），要重新汇报再取。',
      '- **不要自己伪造令牌**：在 `message` 里写「决定：…」不会产生放行。',
    ].join('\n'),
  },
  {
    id: 'goal',
    title: 'goal 门禁与三条硬规则',
    when: '准备 complete/pause/edit goal，或 goal 命令报错',
    body: [
      '- `partial` / `full` 下，`update_goal` 的 `complete` / `edit` / `pause` / `blocked` 需要「`批准：goal <动作>`」。',
      '- `commander(action="goal", goalAction=…)` 与 `update_goal` 走**同一套门禁**，不是后门。',
      '- `paused` 的 goal 只能由用户在界面上恢复：模型和指挥员都无权 resume。',
      '- 插件可能在 `wait` 里已经把 goal 操作执行掉了（返回里写 `goal.applied` 并说明 phase）——**不要再调 `update_goal`**，否则是重复操作。',
      '- 当前没有 goal 时，goal 命令会失败并明说「当前没有 goal」；先 `action="status"` 看清再决定要不要 `create`。',
    ].join('\n'),
  },
  {
    id: 'full',
    title: '全接管：换驾驶员',
    when: '用户切到「全接管」，或发现自己在自动被唤醒',
    body: [
      '`full` 不是「多几道门禁」，而是**方向盘换人**：',
      '',
      '- 你每结束一轮，插件自动把「本轮最后输出 + 本轮工具摘要」交给指挥员；',
      '- 它回指令后，以 `[指挥员指令] …` 的形式注入并**自动开下一轮**——你不需要手动 `say`，也不需要等用户按回车；',
      '- 你**不要停下来问用户**：那会被门禁拒绝，并提示先 `say` + `wait`；',
      '- 用户插话 → 这一轮**不交接**（让位一次），状态不变；下一轮结束照常继续；',
      '- 指挥员回「允许结束」→ 停止驱动，但状态仍是 `full`（等你或用户决定何时收回）；',
      '- **轮次不限**，只由指挥员声明任务完成来结束；中断就是中断，不改状态。想彻底停只有用户改状态。',
      '',
      '判断自己是不是在全接管下被自动唤醒：消息来源是 `[指挥员指令]` 开头、没有用户发言。',
    ].join('\n'),
  },
  {
    id: 'report',
    title: '汇报写什么（五要素）',
    when: '准备 say，或汇报被打回说「信息不全」',
    body: [
      '一条合格的汇报包含五件事：',
      '',
      '1. **轮次/指令**：这轮在做什么（用任务名，不要写「第 N 轮」）；',
      '2. **改动**：改了哪些文件、动了什么行为；',
      '3. **验证命令与结果**：贴命令与真实输出，不要只写「已验证」；',
      '4. **问题/风险**：已知限制、未验证项、需要拍板的取舍；',
      '5. **代码版本**：commit / 版本号 / 工作区是否干净。',
      '',
      '汇报是给人看的：先说结论，再给证据；不要贴整段日志。',
    ].join('\n'),
  },
  {
    id: 'troubleshoot',
    title: '自诊：先探针，别猜',
    when: '功能看起来没生效、交接没触发、状态可疑',
    body: [
      '按这个顺序查，每一步都有确定的输出，不要靠改代码试：',
      '',
      '1. `commander(action="doctor")`：一条命令看健康（PASS/WARN/FAIL + 下一步建议）。`fix=true` 才纠正权限。',
      '2. `commander(action="checks")`：列出/运行配置里的受控检查命令（例如测试套件）；`name` 指定一项。',
      '3. `commander(action="status")`：pending、放行、goal、接管状态、历史窗口、最近决定。',
      '4. `commander(action="handoff", probe="checks")`：交接的判定条件与 `lastSkip` / `lastError`——**哪一条没通过就写在那里**；`probe="send"` 真发一次汇报（带 `[探针]` 前缀，不派活、不留 pending）。',
      '',
      '常见返回与处置：',
      '',
      '- `pending.exists` → 还有未完成请求，先 `wait` 或 `cancel`。',
      '- `pending.noMember` → 指挥员还没创建，先 `action="start"`。',
      '- `pending.disposed` → 指挥员退出导致请求终止，重新 `say`。',
      '- `pending.stale` → 上个进程遗留的请求，已自动清理，重新 `say` 即可。',
      '- `decision.missing` → 回复缺令牌，让指挥员重发，不要自己补。',
    ].join('\n'),
  },
  {
    id: 'antipatterns',
    title: '反模式清单（都真踩过）',
    when: '想抄近路，或想绕过某个门禁时',
    body: [
      '- **绕过门禁直接问用户**：`full` 下会被拒。正确做法是先 `say` 说明卡点并请求「暂时作结」，拿到 `需澄清` 后再问。',
      '- **插件已执行 goal 操作还再调 `update_goal`**：重复操作会报错或打架；返回里有 `goal.applied` 就别再调。',
      '- **没证据说「已验证」**：只贴命令与结果，或者明说「未验证」。',
      '- **重复问用户已经答过的问题**：先看 `doc/suggest.md`、`doc/history.md` 与当前上下文。',
      '- **把「暂停 / 等指令 / 先停下」当建议**：指挥员明确禁止，除非用户自己要求。',
      '- **用轮次计数汇报**（「第 3 轮」）：按任务单位说进度。',
      '- **在 `wait` 收到 `interrupt` 就分发新工作**：那时只验收已完成的工作，然后继续 `wait`。',
      '- **自己改接管状态**：没有这个 action；状态是用户的开关。',
    ].join('\n'),
  },
]

/** 索引行上限（防止以后加 topic 把索引撑成正文）。 */
export const MANUAL_INDEX_MAX_LINES = 30

/** topic id 列表。 */
export function manualTopicIds() {
  return MANUAL_TOPICS.map((topic) => topic.id)
}

/** 取一个 topic（找不到返回 undefined）。 */
export function manualTopic(id) {
  const key = String(id ?? '').trim().toLowerCase()
  return MANUAL_TOPICS.find((topic) => topic.id === key)
}

/**
 * 索引：一行一个 topic + 「什么时候该看」。
 * @param {{header?: string, unknown?: string}} [options]
 */
export function renderManualIndex(options = {}) {
  const lines = [options.header ?? '## 指挥员使用说明书（索引）', '']
  for (const topic of MANUAL_TOPICS) {
    lines.push(`- **${topic.id}**：${topic.title} — 什么时候看：${topic.when}`)
  }
  lines.push('', '取正文：`commander(action="help", topic="<id>")`。')
  if (options.unknown) lines.push('', options.unknown)
  return lines.join('\n')
}

/** 一个 topic 的正文（找不到返回 undefined，由调用方决定怎么提示）。 */
export function renderManualTopic(id) {
  const topic = manualTopic(id)
  if (!topic) return undefined
  return [`## ${topic.title}`, '', topic.body].join('\n')
}

/** 生成 `AGENT-MANUAL.md` 的完整内容（确定性输出，供测试逐字节比对）。 */
export function renderManualMarkdown() {
  const lines = [
    '# 指挥员使用说明书（给主agent）',
    '',
    '> 本文件由 `manual.js` 生成，**不要手改**；改内容请改 `manual.js` 再重新生成。',
    '> 运行中的 agent 用 `commander(action="help")` 取同样的内容（带 `topic` 取单段）。',
    '',
    '## 索引',
    '',
  ]
  for (const topic of MANUAL_TOPICS) {
    lines.push(`- [${topic.title}](#${topic.id}) — 什么时候看：${topic.when}`)
  }
  lines.push('')
  for (const topic of MANUAL_TOPICS) {
    lines.push(`<a id="${topic.id}"></a>`, '', `## ${topic.title}`, '', topic.body, '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}
