# 指挥员模式（dsh-commander）

长线工作的「指挥员模式」：把一个**长期在线、可续接的 Agent Teams teammate** 装成「指挥员」（架构设计 + 督察指挥）。它读全部项目文件、跑只读 shell、可写文件但默认不动手，并通过 `send_message` 与 Lead 多轮对话。斜杠命令 `/commander`。

> 当前版本 **2.9.11**，见 [CHANGELOG.md](CHANGELOG.md)。安装见 [INSTALL.md](INSTALL.md)，最短路径：
>
> ```sh
> git clone https://github.com/leleou209/dsh-commander.git
> # 然后在 DSH 会话里：
> # plugin_manager install_bundle target: "<克隆路径>/dsh-commander"
> ```
>
> 装完 `/commander doctor` 一条命令自检。

## 形态：一个 teammate，不是每轮一张新卡

- 指挥员是 Agent Teams 的 teammate；内部 target 为 `commander`（Agent Teams 要求 ASCII kebab-case），界面描述统一为「指挥员」。
- 已有 teammate 卡片是在改名之前创建的，描述无法修改；`sessionController.rename` 对 teammate 会被“owned by subagent routing”拒绝。新会话/重建 teammate 才会显示「指挥员」描述。
- 首次 `commander(action=start)` 创建；之后一直复用，**不会每轮新建**。
- 它出现在 `list_agents` 中，可以直接 `send_message({ target: "commander", message: "..." })`，也可以走 `commander(action=say)`。
- 消息是异步投递：Lead 发完可以继续干活，回复作为 teammate 消息到达，不阻塞 goal。
- 旧的 `commander-<uuid>` 子agent卡片不会被删除；`commander(action=list)` 会列出它们，并可用 `commander(action=say, target="<旧 id>")` 重新链接、继续对话。

## 它能做什么（权限边界）

| 能力 | 说明 |
|---|---|
| 读全部文件 | `read / glob / grep / read_image`，工作区内外都可读（受宿主文件策略约束） |
| 只读 shell | 白名单按“命令首 token”判断（支持 `git -C <path> <子命令>`）：`git status/log/diff/rev-parse`、`rg`、`sha256sum`、`stat`、`date`、`sed -n`、`jq` 等；`node`、`sed -i`、重定向、构建命令一律拒绝 |
| 自主决策 | 大多数问题由指挥员依据 `doc/suggest.md` 与用户已有需求自行决定；只有会改变用户需求/产品语义且无法判断的事项才请 Lead 决策 |
| 多轮对话 | 同一 teammate 会话持续累积上下文，可反复追问 |
| 找 Lead / 队友 | 允许 `send_message`、`list_agents`（Agent Teams 自带工具） |
| 写文件 | 有 `write / edit` 权限，但默认限制在 `doc/`（`writeScope`）；写代码会拒绝，提示词也要求默认不动手 |
| shell 写 / 改仓库 / 编译 | **拒绝**：白名单外命令、重定向、git 写操作、构建/编译一律拦截 |
| 创建子agent | **拒绝**（它只是指挥循环，不替代工程组） |

> 只读 shell 是保守白名单拦截，不是强沙箱：命令必须落在白名单内，且禁止重定向/子表达式；但不能证明任意脚本都无副作用。需要更强边界时请用只读文件系统沙箱。

## 伴生 UI 窗口（transcript-window，默认启用）

随 commander 同包启用的 Host 侧伴生插件：把客户端加载历史时的窗口收敛到**最近 15 个 turn**（单页上限 34 条消息），更早的记录仍可按页向前加载。

- 只改 `sessionController.events` / `observeEvent` 收到的请求参数，不删 session log、不改模型上下文；
- 关键在**只压不放**：`turnWindow.minTurns` 是「最小值」，抬高它只会让服务端给得更多；真正的上限是 `maxMessages`。所以这里把 `maxMessages`、`minTurns`、`minMessages` 一律**向下压**，客户端要得更少就照办、绝不放大；
- 配置：`turns`（默认 15）、`messagesPerTurn`（默认 2，上限 = turns × 2 + 4 余量）、`debug`（写 `~/.dsh/commander/transcript-window.log`，记录每次真实请求的前后参数，便于验收）；
- `commander status` / `doctor` 会显示真实生效值（如「最近 15 个 turn，单页上限 34 条」）。

> 2.9.3–2.9.8 的旧实现只把 `minTurns` 抬到 15，方向反了，所以看起来「没有效果」；2.9.9 修正。

## 主agent服从规则

- 新任务/阶段开始前，先 `commander say` 汇报目标与计划，再 `wait` 取得指令；不要先问用户。
- 每完成一个可验收阶段，先向指挥员汇报并 `wait`；收到「继续」才继续，收到「允许结束」才交付。
- **问题分级**：单点疑问/小 bug → 指挥员直接答、主agent直接修；方向性/多步工作 → 按批次（3–7 个可验收项或一个完整交付物）连续完成再汇报。不要把小问题包装成计划。
- **批次节奏**：批次内小取舍自行决定，只有整批完成、真正阻塞或需用户拍板才回报。
- 只有指挥员回「需澄清」或明确要求用户拍板时，才 `ask_user_question`；未咨询指挥员就直接问用户会被工具拒绝。
- goal 提醒、工具描述与 guard 三层同时约束。

## 工具

### `commander`

| action | 行为 |
|---|---|
| `start` | 创建或接管唯一的 `commander` teammate；仅当会话没有 goal 时创建一次协作 goal。 |
| `list` | 列出可寻址的指挥员 teammate 与历史可续接子agent。 |
| `say` | 发咨询并登记 pending 请求，返回 `requestId`；**不阻塞**。 |
| `wait` | **无超时**等待该请求结束：指挥员本轮结束即返回回复与 `decision`（继续/需澄清/允许结束）；若有工程组/子agent完成，提前返回 `interrupt`（只验收、不分发），保留 pending，处理后再 `wait`。 |
| `cancel` | 取消 pending；指挥员继续跑也不再恢复等待。 |
| `status` | 只读查看文档、goal、teammate、pending 请求、**当前 CODE_STATE**、持久化健康、放行状态与问用户门禁。 |
| `doctor` | 一条命令自检：安装/运行态/持久化/门禁/UI 窗口/环境，输出 PASS/WARN/FAIL + 下一步建议；`fix: true` 才纠正权限与修剪。 |
| `checks` | 运行**配置里**的受控检查命令（`checkCommands`），返回退出码、耗时与输出尾部；不给 `name` 时列出可用项。 |

### 斜杠命令 `/commander`

```text
/commander 你帮我检索 X 并统计下来      # 直接跟需求 → 按咨询发给指挥员
/commander start|status|wait|cancel     # 子命令照旧
/commander doctor                       # 一条命令自检（PASS/WARN/FAIL + 下一步）
/commander doctor --fix                 # 同一个自检，顺手纠正权限/修剪历史
/commander checks                       # 列出配置的受检命令
/commander checks offline               # 跑一条（拿退出码与输出尾部）
/commander record 修复了登录 500         # 写 doc/history.md
/commander help                          # 用法（不带参数也是它）
```

- 参数不是已知子命令时，**整段按咨询投递**，不再报「未知子命令」；指挥员还没创建时会先自动创建。
- 只有「看起来像英文子命令但拼错」才报错并提示正确写法（如 `statsu` → `status`），避免把拼写错误当成需求发出去。
- 中文别名：`启动/开始/列表/状态/自检/体检/检查/说/问/等待/取消/记录/帮助`。
- 投递后立即返回（不阻塞）；要拿结论再 `/commander wait`，或让主agent调 `commander action=wait`。

### 决策与放行协议（改编自 Luna advisor loop）

- 指挥员每轮回复必须以 `决定：继续` / `决定：需澄清` / `决定：允许结束` 开头。
- `继续` 必须给下一轮工作、依据与验收标准；`需澄清` 给具体缺口；`允许结束` 必须附「适用状态 / 验收结论 / 验证证据 / 未完成必做项 / 已知限制」。
- 每条回复头部还必须有一行 `请求：<REQ id>`，与 Lead 消息里的 `[REQ ...]` 一致；缺 REQ 按 failed 提示；旧请求的迟到回复（REQ 不匹配）会被忽略，等待继续。
- **无隐式放行**：普通回复、超时、interrupt、工具完成、“本轮完成”都不算放行；决策令牌只认**第一条非空行**，正文里提到“允许结束”不会误放行。
- **代码状态绑定**：`say` 会自动带上 `[CODE_STATE …]`（**只绑文件内容快照**：相对路径 + 内容哈希；排除工作区根部的 `doc/`；**不含 git HEAD**）；`允许结束` 必须回显同一个 token，且 `wait` 会**重算当前状态**；内容一变放行即失效。
  - 不含 HEAD 的原因：提交本身不改内容，不该让放行失效；而「只提交 `doc/`」也会移动 HEAD —— 绑它等于让文档提交误伤放行。提交号仍在 `status`/`doctor` 里展示（标注“不绑定”）。
- 只有 `允许结束` 才会登记放行；`write/edit/apply_patch` 与**会写文件的 shell 命令**会立即让放行失效，只读 `git status` / `Get-Content` 不会。
- 放行写入插件自有状态文件（`~/.dsh/commander/state.json`，可用 `statePath` 改），插件重载/重启后会重新 hydrate；`update_goal complete` 前还有异步状态校验，外部改代码也会被拒绝。
- 启用 `enforceApproval`（默认开）时，没有有效放行的 `update_goal(complete)` 会被 Host 拒绝。
- **goal 状态/内容变更**（`edit/pause/blocked`）必须先取得指挥员在回复开头单独一行 `批准：goal <动作>`；正文示例/引用里的批准无效，并会在 `wait` 输出提示；`complete` 只认 `决定：允许结束`。
- **paused goal 只能由用户在界面恢复**：模型/指挥员无权 `resume`；插件不再提供 resume 批准，guard 直接拒绝并提示用户手动恢复。
- 指挥员对模糊需求按最可能意图推断并给推荐，不反复追问；只有不可逆/改变产品语义/成本明显时才需澄清。
- `status` 显示真实指挥轮次、最后决定、pending、放行状态与 goal 批准。
- 主agent的 `say` 汇报应包含：轮次/指令、改动、验证命令与结果、问题/风险、代码版本（有 git 用 HEAD+diff；无 git 用文件快照/时间戳，不编造）。
- 已存在的旧 teammate 在 `start` 时会自动收到一次「契约同步」消息，不需要重建。

参数：`action`（必填）、`message`、`requestId`、`target`。

等待协议：

1. `say` → 拿到 `requestId`，pending 持久化。
2. `wait` → 阻塞到“指挥员本轮结束”或“其他工程组/子agent 完成”。
3. 收到 interrupt → 只做验收/记录，**不分发新工作**，然后再次 `wait`（同一 turn，不产生新 goal 轮次）。
4. 用户中断 → pending 保留；下一轮看 `status` 决定是否 `wait` 恢复。
5. 用户/主agent决定不等 → `cancel`。

### `commander_record`

把主agent完成的实质行为倒序写入 `doc/history.md`，供指挥员下一轮参考。

## 四份协作文档（`doc/`）

- `doc/suggest.md`：**仅用户**编写的建议板；指挥员每轮优先读它。插件只在缺失时建骨架。
- `doc/history.md`：主agent用 `commander_record` 记录行动历史。
- `doc/plan.md` / `doc/agent.md`：项目计划与设计导向的权威位置；指挥员有写权限但默认不动手，需要留痕时可写，或由主agent/用户维护。

## 持久化与状态文件（2.9.8 加固）

状态放在 `~/.dsh/commander/state.json`（`statePath` 可改），由 `state-store.js` 管理：

| 方面 | 行为 |
| --- | --- |
| 权限 | 目录 `0700`、文件 `0600`；`/commander doctor --fix` 可纠正被放宽的权限 |
| 原子写 | 先写 `.tmp` 再 `rename`，不会出现半截文件 |
| 跨进程 | `state.json.lock`（`O_EXCL`）；拿不到锁就**不覆盖**，`status`/`doctor` 报「另一个进程正在写」 |
| 损坏 | JSON 解析失败 → 原文件改名 `state.json.broken-<ts>` → 空状态继续，`readError` 进 `status`/`doctor` |
| 超大 | 超过 `stateMaxBytes`（默认 256KB）同样备份后重置 |
| 修剪 | `interruptions`/`rounds` 保留最近 `stateKeepPerTable`（默认 200）个会话、默认 90 天 |
| 迁移 | 读到旧 `version` 字段或平铺格式会迁移读取（`status` 显示「已从旧版本 … 迁移读取」），表不丢 |

## 受控检查（`checks`）与自检（`doctor`）

`checks` 让指挥员能**自己复跑验证**，而不是只采信 Lead 的结论：

- 只有 `checkCommands` 里列出的命令能被执行，模型只能选名字、不能传任意参数；
- 每条命令 `cwd` 在会话工作目录，超时 `checkTimeoutMs`（默认 180s）后被**整组进程杀掉**；
- 输出截断为末尾 200 行 / 32KB，返回退出码与耗时；并发上限 1；
- 它**不**解锁写操作，也不影响放行状态。

配置示例：

```yaml
checkCommands:
  - offline = node test/offline.mjs
  - regressions = node test/regressions.mjs
```

`doctor`（`/commander doctor`）把这次排障要查的东西一次说完：安装目录与 profile 挂载是否一致、**三处版本是否一致**（profile 里装的 / 磁盘 `package.json` / 运行中进程）、teammate/goal 状态、状态文件路径/权限/读写错误/表计数、问用户门禁、历史窗口、cwd 与 CODE_STATE，最后给 PASS/WARN/FAIL 结论和下一步建议。默认只读，`--fix` 才动手。

分级原则：**FAIL 只留给真故障**（挂载指向别的目录、状态文件不可写/写错误）；「配置期望未满足」（例如历史窗口没挂上）记 **WARN**，不影响使用。

## 文案与语言

用户可见文案集中在 `messages.js`：`zh-CN` 全量、`en` 兜底，key 由测试保证两边对齐；**缺 key 会显式输出 `⟦missing:<key>⟧` 并 warn**，不会静默回退成英文。

- 每条按「发生了什么 + 影响 + 下一步」写，实现术语只进日志；
- 分级前缀 `[信息]/[注意]/[失败]`；「已生效」与「失败」不混用；
- `locale` 支持 `zh-CN` / `en`（`zh`、`zh-Hans` 归一化到 `zh-CN`）。

## 接管状态（takeover，2.9.12）

指挥员对主会话的接管程度有四个状态，决定**哪些门禁生效**：

| 状态 | 含义 | 问用户 | goal 的 complete/edit/pause/blocked |
| --- | --- | --- | --- |
| `off` 无指挥 | 没有指挥员 | 自由 | 自由 |
| `observe` 不接管 | 指挥员只当顾问 | 自由 | 自由 |
| `partial` 部分接管 | 接管 goal 命令与放行 | 自由 | 需要放行/批准 |
| `full` 全接管 | 你不在场，指挥员代言 | **必须先咨询** | 需要放行/批准 |

- 默认**推导**：没有 teammate → `off`；有 teammate 且 goal active → `partial`；否则 `observe`。
- 显式覆盖：`/commander takeover <off|observe|partial|full>`，或 `/commander takeover reset` 回到推导；覆盖值写进 `state.json` 的 `takeover` 表。
- 你发来真实消息时 `full` 自动降为 `partial`（你在打字就说明你在场），`status` 会显示「部分接管（auto）」。
- composer 工具行（模型选择器与发送键之间）有一个**皇冠图标**显示当前状态：灰色=观察、蓝色=部分、琥珀=全接管，点击循环切换。

> 这就是 2.9.0–2.9.11 那条「每轮问用户都要先过指挥员」的收窄：只有 `full` 才拦。`off`/`observe` 下问凭据、选文件这类只有用户能答的问题不再白烧两轮。

## 中断恢复

- **用户中断**：用户主动取消/打断、UI 暂停；记录 `source=user`，默认不自动恢复，但指挥员可显式 `批准：goal resume`。
- **agent 自己断**：指挥员/插件执行的 pause/blocked；记录 `goalSource=agent`，会话恢复时自动 resume。
- **异常中断**：`error`、`max-tokens`、父级/hook/dispose 等；记录 `source=abnormal`，自动 resume。
- 插件通过 Host `goals` 服务恢复，已实测可 resume paused goal（模型 `update_goal` 仍会被宿主拒绝）。
- 开关：`resumeOnAbnormal`（默认 true）。
- 恢复后 pending 请求仍在 `commander status` 中，由主agent决定是否继续 `wait`。

### 跨重启的陈旧 pending（2.9.10）

进程重启后，旧 pending 对应的指挥员回合已经不存在，回复永远不会来。插件用 `process.uptime()` 反推**进程启动时刻**（插件重载不会刷新它，所以重载不受影响）：

| 场景 | 行为 |
| --- | --- |
| `pending.sentAt` 早于进程启动 | 判定「陈旧」；`status` 标注「陈旧（来自上个进程，可直接重新 say）」 |
| 对陈旧请求调 `wait` | 立即返回 `kind=stale` + 原因，不阻塞 |
| 对陈旧请求调 `say` | 允许覆盖（先清理陈旧记录并记一条 info 日志），不再抛「已有未完成的请求」 |

## 需要用户输入时怎么停（不硬编码）

goal 处于 `active + armed` 时，harness 会在**没有用户消息**时自动续轮。如果这一轮只是「等用户选方向/给时间窗」，就会连续空转；而用户不在线时，「等用户批准」本身不可能发生。

插件的做法是**协议**，不是硬性拦截：

1. Lead 发现无法在无用户输入下推进 → `commander(action=say)` 说明卡点，并请求「暂时作结」。
2. 指挥员回 `决定：需澄清` + 头部 `批准：goal pause`（插件直接执行 pause），并写清恢复条件。
3. Lead 暂停 goal、用 `ask_user_question` 问用户、**本轮结束**。
4. 用户回复后，Lead 再汇报；指挥员 `批准：goal resume` 恢复自动推进。

对应约束：

- `ask_user_question` 的 guard 会拒绝「没先问指挥员就问用户」，并提示先请求「暂时作结」。
- goal 提醒文本里写明了这条流程，每轮都会出现在 agent 上下文里。
- 指挥员契约要求：无法推进时主动 `批准：goal pause`，不要保持 active 空转。

> 不采用「插件按轮数自动 block」的硬编码：那会把纯只读研究型 goal 也停掉，且绕过了指挥员的判断权。

## goal 规则

- 指挥员可以直接管理 goal：`commander(action="goal", goalAction="create|edit|pause|resume|blocked|complete|clear", objective?, maxRounds?)`。
- 指挥员回复头部写 `批准：goal <动作>` 时，插件直接执行，不再交给主agent调 `update_goal`；`create/edit` 可附 `目标：…`、`轮次：N`。
- goal `complete` 后可按下一阶段 `create` 新 goal，持续循环。
- 用户 `paused` 也可以由指挥员显式 resume（插件侧），模型工具仍不能 resume。
- 只有 `action=start` 在**没有 goal** 时自动创建一次协作提醒；不会覆盖用户已有 goal。

## 安装与配置

用 `plugin_manager` 安装本目录；Agent Teams 需要已启用的 agent-team profile（本机默认已启用）。

打包分发（换环境测试）：`npm pack` 产物为 `local-dsh-commander-<version>.tgz`；解压后得到 `package/`，重命名为 `dsh-commander-<version>` 即可作为目录安装。详见 `INSTALL.md`。

`cordis.patch.yml` 的 `config` 可调：

| 字段 | 默认 | 说明 |
|---|---|---|
| `commanderName` | `commander` | teammate 名字（同时是 `send_message` 的 target） |
| `provider` | `spawn` | 创建 teammate 的 provider |
| `advisorProvider` | `''` | 指导者模型 provider（Plugin Manager 可填） |
| `advisorModel` | `''` | 指导者模型 id（Plugin Manager 可填；留空沿用 Agent Teams 路由） |
| `advisorReasoningEffort` | `''` | 指导者 reasoning effort（可留空） |
| `readOnlyTools` | read/read_image/glob/grep/web_search/web_fetch/write/edit/apply_patch | 允许的工具（write/edit 有权限但默认不建议动手） |
| `extraReadOnlyTools` | `[]` | 追加允许的工具 |
| `shellTools` | `pwsh,bash` | 只读 shell 工具名；自动过滤不可用项 |
| `writeScope` | `doc` | 指挥员可写的相对目录；留空或 `*` 表示不限制 |
| `enforceApproval` | `true` | 没有「允许结束」时拒绝 `update_goal(complete)` |
| `resumeOnAbnormal` | `true` | 异常中断恢复时自动重新 arm active goal |
| `goalMode` | `augment` | `off` 时完全不碰 goal |
| `goalReminder` | 见源码 | 写入 goal 的协作提醒 |
| `statePath` | `''` | 状态文件路径；留空用 `~/.dsh/commander/state.json` |
| `expectTranscriptWindow` | `false` | 期望 UI 历史窗口已挂载；为 `true` 且未挂载时 `status` 报故障 |
| `locale` | `zh-CN` | 用户可见文案语言：`zh-CN` / `en` |
| `checkCommands` | `[]` | 受控检查白名单，`name = command` 或直接命令；`checks` 只执行这里列出的项 |
| `checkTimeoutMs` | `180000` | 单条检查超时，超时整组进程被杀 |
| `stateMaxBytes` | `262144` | 状态文件上限，超出备份后重置 |
| `stateKeepPerTable` | `200` | `interruptions`/`rounds` 每表保留的会话数 |

## 验证

```sh
node test/offline.mjs          # 工具/命令/门禁/doctor/checks
node test/regressions.mjs      # CODE_STATE、决议行、文案目录
node test/state-store.mjs      # 权限、跨进程锁、损坏隔离、迁移、修剪
node test/transcript-window.mjs
```

`test/regressions.mjs` 覆盖：CODE_STATE 解析真实提交号、内容哈希（touch 不误判）、只排除根部 `doc/`、决定行允许后缀说明、`zh-CN`/`en` key 对齐与缺 key 显式报错。
`test/state-store.mjs` 覆盖改进点 5 的五条验收：0600/0700、锁住不覆盖、坏文件备份、旧版本迁移、表修剪。

覆盖：teammate 只创建一次、`list/say/round` 不新建卡片、消息投递、goal 只创建一次且 round/say 不改动、paused goal 保持暂停、非主会话拒绝、写文件/构建命令被 guard 拒绝、事件与命令注册。

## 已知限制

- 只读 shell 是白名单守卫，不是安全沙箱。
- 设计上不使用 `ask_user_question`：多数问题由指挥员依据用户原有需求自行决策；只有会改变用户需求/产品语义的事项才请 Lead 决策。
- teammate 的工具面通过 `tools.restrict` + guard 收紧；第三方插件在 teammate 自己作用域注册的工具不受影响（DSH 设计使然）。
- 旧的 `commander-<uuid>` 是子agent，不会自动变成 teammate；但可通过 `commander(action=say, target="<id>")` 续接。
- pending、放行、中断记录与轮次写入 `~/.dsh/commander/state.json`（`statePath` 可改）；写盘失败时降级内存，`status` 会显示「内存模式」并给出错误原因。
- `CODE_STATE` 必须写成单独一行：`适用状态：CS-…`（整行只有 token）；夹带说明文字会导致放行失败。
- `turn/end` 缓存只接受 `event.time >= pending.sentAt` 的回复；旧请求迟到的回复不会当成新请求答案。
- 快照 4000 文件 / 深度 8 上限，超出后状态不再变化。
- `CODE_STATE` 只排除**工作区根部**的 `doc/`：`commander_record` 与计划板写入不会让放行失效，但 `src/doc/` 这类真实代码目录仍计入。

- 轮次只统计有有效决策的回复；interrupt/失败不计入轮次。
- 外部改代码会在 `update_goal complete` 前的异步校验中被拒绝，不需要先跑 `status`。
- `doc/plan.md` / `doc/agent.md` 指挥员有写权限但默认不动手；需要自动留痕时可让它写，或由主agent维护。

## 许可证

[MIT](LICENSE) © 2026 leleou209

## 状态文件与隐私

- 运行时数据只写在 `~/.dsh/commander/state.json`（pending 请求、放行记录、中断记录、轮次计数）与可选的 `transcript-window.log`（仅 `debug: true` 时写）；
- 仓库里不含任何会话内容、密钥或本机绝对路径；
- 指挥员的读写范围由配置 `writeScope`（默认 `doc/`）与只读工具白名单约束，**它不是安全沙箱**。
