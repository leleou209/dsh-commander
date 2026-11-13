# 更新日志

版本号与 `package.json` / `index.js` 里的 `PLUGIN_VERSION` 一致；`/commander status` 首行显示运行中的版本。

## 2.9.37

用户：「改成英文吧，英文省token」。说明书整份英文化，契约令牌不动。

- **`manual.js` 全量英文**：9 个 topic 正文、索引的 `when` 行、`COMMANDER_TOOL_DESCRIPTION`。工具说明从 382 字符（中文）变成 **621 字符（英文）**，但按 token 估算从 ~345 降到 ~178（常驻成本约省一半）；整份说明书 ~2853 → ~2628 token（约省 8%）。
- **契约令牌保持中文原样**：`决定：继续 / 需澄清 / 允许结束`、`批准：goal <动作>`、`请求：…`、`适用状态：CS-…`。它们是 `classifyReply()` 匹配的协议字面量，翻译等于改协议；`tokens` 段对每个令牌给了英文解释（continue / need clarification / allow finishing）。
- **测试**：`test/manual.mjs` 8 → 9 项，新增「说明书是英文单语但令牌保持中文」（正文中文字符 < 120 且五个令牌都在），并把「三条硬门禁在常驻说明里」的断言从中文词改成英文词。
- **`AGENT-MANUAL.md`** 重新生成（9838B）；`start` / `doctor` 的指路句也改成英文，与说明书语言一致。

门禁措辞自检：`complete a goal only after the commander explicitly says 允许结束` / `goal complete/edit/pause/blocked need 批准：goal <action>` / `under full takeover ask the user only after say + wait`——三条与中文版一一对应，未弱化、未歧义。

## 2.9.36

用户反馈：「使用插件的 agent 不知道使用手册」。原来主agent 能看到的只有一段约 1.5k 字的工具说明，四态语义、交接循环、门禁细节、踩过的坑全塞不进去——新装的 agent 只能靠猜。

- **新增 `manual.js`（说明书单一事实源）**：9 个分段 `overview` / `states` / `loop` / `tokens` / `goal` / `full` / `report` / `troubleshoot` / `antipatterns`。纯数据 + 纯函数，无宿主依赖、无时间戳。
- **新增 `commander(action="help", topic?)`**：不给 topic 返回索引（每段一行 + 「什么时候该看」，13 行），给 topic 返回正文；未知 topic 返回索引并列出可用 id。
- **工具说明瘦身**：从 ~1.5k 字压到 **382 字符**（`COMMANDER_TOOL_DESCRIPTION`），只留「是什么 + 11 个 action + 3 条硬门禁 + 指路 help」。`test/manual.mjs` 卡 800 字符上限，防止以后又长回去。
- **`AGENT-MANUAL.md`**：由 `manual.js` 生成（9.4KB），随包分发；`test/manual.mjs` 逐字节比对，改了源不重新生成就会红。
- **入门指路**：`start` 与 `doctor` 的输出各加一行「首次使用请 `commander(action="help")`」；INSTALL 增加「装完之后第一件事」。
- **中文单语**：说明书只写中文——契约令牌（决定/批准/允许结束）本身就是中文，翻译等于改协议。`locale: en` 用户会看到中文说明书，作为已知限制记入 README。

测试：新增 `test/manual.mjs`（8 项）并登记进 `checks`；七套全绿。

## 2.9.35

把 2.9.34 那轮审计里剩下的四项收尾：

- **交接正文不再写死中文**。`renderReport()` / `renderInstruction()` 现在接受注入的 `t()`，`index.js` 传自己的翻译函数；`handoff.js` 缺省用 `createTranslator('zh-CN')`，所以单独调用和单测不受影响。`messages.js` 新增 `handoff.*` 共 12 个 key（zh/en 各一份）。**唯一的例外是契约令牌**——「决定：继续 / 需澄清 / 允许结束」不随语言变，换语言等于改协议，en 文案里保留中文令牌并附英文解释。
- **探针不再可能污染真实状态**。`commander(action="handoff", probe="send")` 三条硬约束：（1）已有活着的 pending 就直接跳过，不顶掉用户正在等的请求；（2）消息带 `[探针]` 前缀 + 一句「请只确认收到，不要据此派活」；（3）登记完立刻清 pending，且**不注入**回主agent（探针不该开新一轮）。输出里明确写出这三件事的结果。
- **状态文件 schema 3 → 4**，`takeover` 表正式退役（2.9.19 起接管状态就只在内存里）。`migrateState()` 只拷贝 `STATE_TABLES` 里还活着的表，所以旧文件里的 `takeover` 在下次写入时自然消失，不需要专门迁移代码；`test/state-store.mjs` 加了 2 项断言（退役表读得进但不进内存、落盘后消失；同版本不报迁移）。
- **删掉 `nextTakeover()`**：图标菜单和斜杠命令都改成直接选状态，循环切换的辅助函数已无调用方，留着只会误导。

测试：offline / takeover(12) / handoff(19) / regressions(15) / state-store(12) / transcript-window 全绿。

## 2.9.34

以自己为使用案例做了一轮审计，修掉四个真 bug：

- **斜杠命令改状态不通知、也清不掉停运**：`/commander takeover <状态>` 原来只写覆盖值。于是（a）状态变了但主agent 不知道；（b）停运后从斜杠命令**恢复不了**。现在图标路由与斜杠命令共用 `applyTakeoverChange()`：写值 + 通知 + 清 `stopped/interrupted/turnEnded/lastSkip/lastError` 三件事一起做。
- **`pre-step` 只按 source 匹配自己的消息**：`wakeWithInstruction` 在 `senderSessionId` 不合法时会退回 `runtime-context`，那时 `source.kind` 不是 `agent-message`，fail-closed 校验就漏掉了这条指令。改成只认 id 前缀 `commander-handoff-`。
- **空输出静默跳过**：`report` 和 `tools` 都为空时直接 return，`turnEnded` 已被消费却没有任何记录。现在记 `lastSkip`。
- **工具摘要超 16 条直接丢弃**：现在补一行「…还有 N 条（未列）」。

顺带优化：`lastTurnStartSeq()` 改为从后往前找第一个 `turn/start`，长会话不再每轮全量扫描事件。

## 2.9.33

- **失败路径补齐 pending 清理**：抽出纯函数 `afterWait()`（`handoff.js`）统一决策——`dead`/`timeout` 停运、用户插话让位、`stale`/`failed` 也停，**这三种情况都会清掉 pending**，不再留脏记录；`stopping` 时不动 pending。`test/handoff.mjs` 加了 4 项断言覆盖这三条。

## 2.9.32

- 交接摘要限定在本轮：`lastSeq` 在插件重载后是 0，不限窗口会把整个会话的工具都扫一遍（实测扫出 2811 条）。新增 `lastTurnStartSeq()` 取最后一个 `turn/start` 作为下限。

## 2.9.31

- **根因二：`sendToCommander` 缺 AbortSignal**。底层 team 服务会校验 `AbortSignal`，传 `undefined` 直接抛 `signals[0] is not of type AbortSignal`。交接和探针都改成自带 `new AbortController().signal`。这个错误只在真正发送那一刻出现，前面的日志排查看不见。

## 2.9.30

- 新增 `commander(action="handoff")` 探针：报告判定条件、上次跳过原因、上次异常、各原语可用性，`probe="send"` 时真发一次汇报并清掉 pending。**没有这个探针，前四个根因都是靠猜的。**
- 驱动内部的 catch 也写 `lastError`（原来只写日志，status 里看不见）。

## 2.9.29

- **根因一：`ctx.agents` 需要 inject**。照抄 goal-round-driver 用了 `ctx.agents.withoutInitiator(...)`，但本插件 `inject` 只有 `['tools','subagents']`，一调用就抛 `cannot get property "agents" without inject`，交接在第一步就死。改成 `ctx.get('agents')`，拿不到就直连。

## 2.9.26

- **修自动交接不触发**：`agent/status=idle` 和 `turn/end` 的到达顺序不固定。原来只在 `agent/status` 里驱动，而驱动又要求 `turnEnded=true` —— 顺序反过来时这一次交接就被静默丢掉了（实跑验证：pending 里空的，指挥员根本没收到）。现在 `turn/end` 本身就是触发点，`agent/status` 只作兜底，且顺序不对时延迟 300ms 重试一次。
- **`status` 的「自动交接」行带诊断计数**：`（idle×N，turn/end×M）`。0/0 说明事件根本没到插件，>0 说明是门禁挡住的 —— 下次排查不用猜。

## 2.9.25

- **交接汇报带上工具摘要**：`summarizeTools()` 把本轮的 `tool/call` + `tool/result` 配成一行一条（`✓/✗ 名字: 参数前 60 字`，最多 16 行）塞进交给指挥员的汇报。之前只有最后一段文本，指挥员每轮都在盲判，得自己跑 `status`/`checks` 才知道改了什么。
- **只读 shell 白名单补 `grep` 一族**：名单里有 `rg` 却没有 `grep`/`egrep`/`fgrep`，指挥员真撞上过；顺带补 `which`/`where`/`column`/`od`/`xxd`/`hostname`/`true`/`false`。
- **澄清一条误报**：指挥员上次汇报说"管道拆分不感知引号（`Select-String -Pattern 'a|b'` 会被拆段拒绝）"——实测是**误判**，`splitUnquotedCommands()` 一直是引号感知的。它当时撞上的是 `grep` 不在白名单。现在加了回归断言锁住：引号内的 `|` 放行、真实管道仍逐段校验、`Get-Content a.txt | Set-Content b.txt` 仍被拒。

## 2.9.24

自动交接的健壮性补强（A 组五条）。

- **指挥员挂死不再无限等**：`waitCommanderGuarded()` 每 30s 探一次成员状态，`failed`/消失即判 `dead`；另有 20 分钟硬上限。判定后**停运**（`stopped=true`），不驱动、不改接管状态；重新设定一次接管状态即可恢复。
- **只在真的结束一轮之后交接**：宿主的 `idle` 也包含 `maintenance`（压缩等），原来可能把指令插进正在整理的会话。现在要求 `turn/end` 发生过（`turnEnded`），一次 `turn/end` 只交接一次。
- **排队后 fail-closed**：新增 `agent/pre-step` 校验——交接指令被取用前若接管状态已不是 `full`，直接 `{kind:'reject'}`，绝不带过期指令开跑。
- **不再用轮次编号**：`renderReport()` 去掉 `#N`，改为带「当前任务」（取 goal 目标）；注入的指令里也写明"进度以任务为单位汇报，不要用轮次计数"。
- **status 增加「自动交接」行**：未启用 / 待触发 / 等待指挥员回复 / 你刚插过话 / 已停运，一眼看出它是在跑还是卡住了。

## 2.9.23

**`full` 从"加门禁"改成"换驾驶员"**：主agent 每轮停下就把输出自动交回指挥员，钩子等它的指令，再把指令注入回去唤醒新一轮。轮次不限，只由指挥员声明任务完成来结束。

- 新增 `handoff.js`（纯逻辑）：`shouldHandoff()` 判定何时交接、`classifyReply()` 分「允许结束 / 需澄清 / 继续」、`renderReport()` / `renderInstruction()` 两段文案。
- 新增自动交接驱动（照宿主 `goal-round-driver` 的骨架）：`agent/status → idle` 触发、按 agent 串行化、`ctx.agents.withoutInitiator` 起跑。
- 唤醒用宿主原语 `agent.followup(message)`（塞进 `inbox.next-turn` 并唤醒驱动器）；注入的指令 `source` 用 `{kind:'agent-message', form:'relay', senderSessionId}`，失败退回 `runtime-context`。
- **中断就是中断，不改接管状态**：用户发言或 `turn/end` 被中断，只让这一轮不交接（方向盘交还给你），`full` 保持不变。
- 取本轮输出用 `lastAssistantText(session, lastSeq, lastAt)`，交接后推进基线，不会把同一段话重复发。
- 指挥员回「允许结束」→ 停止驱动（不自动改状态）。
- 测试：新增 `test/handoff.mjs`（9 项），并登记到 profile 的受控检查（`commander(action="checks")` 现在有 6 项）。

## 2.9.22

全接管的强制力补强，以及按用户决定去掉自动降级。

- **去掉「你发言就降级」**：`full` 不再因为你发真实消息而自动降为 `partial`。理由是你随时能中断、有时确实要插话，而且现在有图标菜单——硬控制权在用户手里，不该由"说过话"推断"你在场所以不需要挡"。`onUserReturn` 整个删掉。
- **堵 `commander(action="goal")` 后门**：它内部直接调 `goals.complete/pause/edit/block`，一行审批检查都没有，而调用者只要根 agent 就行——等于 `update_goal` 的批准门禁可以被绕开。现在抽出 `goalGateError()`，`update_goal` 的 guard 与 `commander(goal)` 共用同一套判定；指挥员自己管 goal 时豁免（`commanderIds`）。
- **堵 `start(state=...)` 自我降级**：`state` 参数只在**真的新建**指挥员时生效。已存在的指挥员调用 `start(state="observe")` 不再改变接管状态。
- **subagent 也纳入问用户门禁**：之前 `ask_user_question` 只拦根会话，派个子agent 去问就能绕开全接管。现在一并拦。
- **修状态来源显示**：`resolveTakeover` 之前对任何覆盖值都硬编码 `source: 'user'`，所以状态行永远显示「你设定」。现在透传真实来源（`user` / `init`）。

## 2.9.21

- **修 2.9.20 的通知送不到模型**：2.9.20 往会话里写的是 `developer/message`，日志里查得到，但宿主的 `projectToolUpdates` 在 `toolUpdate` 未定义时会把 developer 消息整批过滤掉（`withoutDeveloperMessages`），只有 tool-addition/tool-removal 那类才留。等于写进黑洞。
- 改用宿主自己给模型注入运行期事实的通道：`user/message` + `source.kind = 'runtime-context'`。实测模型上下文里能看到「[接管状态] 用户已把接管状态切为「部分接管」…」。
- `source.kind` 不是 `'user'`，所以仍然不会触发「全接管自动降为部分接管」，也不会清零「已咨询指挥员」。
- 顺带把 `announceTakeover` 里为 developer/message 推算 turn/step 的逻辑删了（user/message 不需要）。

## 2.9.20

- **切换接管状态会告诉主agent**：你在图标菜单里换状态，Host 会往会话里写一条通知，内容是「[接管状态] 用户已把接管状态切为「部分接管」：goal 的 complete/edit/pause/blocked 需要先取得指挥员批准；问用户不受限。」之前切换是纯内存写入，主agent 完全不知道，只能等撞上门禁才发现。
- 这条通知的 `source` 不是 `user`，所以不会触发「全接管自动降为部分接管」，也不会清零「已咨询指挥员」。
- 状态没变就不写（反复点同一个选项不刷屏）；`commander(action="start")` 落定状态时也写一条。
- 路由 POST 的返回里多了 `announced`，用来确认这条通知到底写没写进去。
- ⚠️ 这一版写的是 `developer/message`，实测模型读不到，已在 2.9.21 修正。

## 2.9.19

接管状态从"每轮推导 + 落盘覆盖"改成"启动时初始化 + 只在内存里"，并让图标菜单成为启动入口。

- **启动即初始化**：没有指挥员 → `off`；有指挥员 → 你选过的值，没选过就是 **`partial`**。接管宽度不再跟 goal 起落（以前有 goal 才 partial、没 goal 是 observe）。
- **不跨进程沿用**：`takeover` 表退役，状态只在内存里。重启后按启动口径重新初始化，上一次的 `full` 不会在新进程里复活——那是唯一会挡住你自己问自己的方向。
- **`off` 改成"不运行指挥职责"**：不再意味着"没有指挥员"。指挥员留在后台睡觉，`commander(action=say|wait)` 直接被拒绝并回一句「用户已切换至不指挥状态，指挥agent已休息，请自行思考」。没有"解除指挥"这个动作——切回 `observe` 及以上它就回来。
- **菜单即入口**：指挥员还没起来时，选「不接管」及以上会顺手把它启动起来（`spawnTeammate`，和主 agent 自己启动同一个函数），指挥员就以你选的状态进场；选 `off` 什么也不启动。菜单底部有提示说明这件事。
- `commander(action="start")` 新增可选 `state`：用户说"当顾问"传 `observe`、说"全接管"传 `full`，不说就 `partial`。启动输出里多一行「接管状态」。
- 菜单去掉「自动（跟随 goal）」：推导值现在就等于 `partial`，这一项已经没有意义。

## 2.9.18

- 修 `/commander/takeover` 在部分环境里 404：路由原来写在 `ctx.effect` 里用 `ctx.get('webServer')` 取服务，插件加载顺序不同时会取到 `undefined` 然后直接 return，之后再也不会注册（vps-hub 上就是这样，图标拿不到状态）。现在改成 `ctx.inject(['webServer'], …)`，等 webServer 就位再注册。

## 2.9.17

- 去掉切换状态后的文字回显：之前点完菜单，图标会短暂变成一段文字（"全接管"等），而那段文字本身也带着点击热区，点上去会直接把状态再改一次，很容易误触。现在切完只更新颜色，状态名只在鼠标停靠的 `title` 提示和菜单里出现。

## 2.9.16

- 菜单改用 `ReactDOM.createPortal(menu, document.body)`：composer 里有 `transform` 祖先时，`position: fixed` 会相对那个祖先定位，菜单因此固定出现在视口右下角。挂到 body 后 `fixed` 才是真正的视口坐标，也不再被 composer 裁切；保留滚动收起、视口夹取与上下翻转。

## 2.9.15

- 修菜单定位：`position: fixed` 记录的是**点击那一刻**的视口坐标，页面滚动后菜单会飘到别处（截图里跑到了右下角）。现在滚动/缩放会立即收起菜单；坐标按视口夹取（不越右边界），上方放不下就朝下展开；菜单固定 208px 宽，长文案收短为「自动（跟随 goal）」。

## 2.9.14

- composer 图标重做：平时只显示皇冠 logo（按状态着色；`off` 时压暗但仍可点，不再"关掉就找不回来"），鼠标停靠高亮并显示当前状态，选完短暂回显状态名。
- 点击改为**选择菜单**：四个状态 + 「自动（跟随 goal 状态）」，当前项有标记；`Esc` 或点外面收起；菜单用 `position: fixed` 锚定按钮，绕开 composer 的裁切。
- 状态标签由 Host 随响应下发（`labels`），客户端不再自己维护文案。

## 2.9.13

- 修 `commander(action="checks")` 的输出契约：补 `exitCode`（之前真跑命令会被输出校验拒绝，报 `value.exitCode is not a declared property`）。
- profile 侧配好受控检查（`offline` / `takeover` / `regressions` / `state` / `window`），指挥员现在能自己复跑测试，不必只采信 Lead 的结论。

## 2.9.12

- **接管状态（takeover）四态**：`off 无指挥` / `observe 不接管` / `partial 部分接管` / `full 全接管`。默认推导（无指挥员=off、有 goal=partial、否则 observe），可用 `/commander takeover <状态>` 显式覆盖并落盘；用户发来真实消息时 `full` 自动降为 `partial`。
- **问用户门禁收窄到「全接管」**：`ask_user_question` 只在 `full` 下强制先咨询指挥员；`observe`/`partial` 直接问，不再为凭据、路径这类只有用户能答的问题白烧两轮。
- **goal 门禁按状态生效**：`complete/edit/pause/blocked` 只在 `partial`/`full` 下需要放行或批准。
- **composer 图标**：客户端半注册到 `conversation.input.right`（模型选择器与发送键之间），用皇冠图标显示接管状态（灰=观察、蓝=部分、琥珀=全接管），点击循环切换；数据来自 Host 的 `/commander/takeover` 路由。
- `status` / `doctor` 新增「接管状态」行，并把门禁说明改成带原因的文字。

## 2.9.11

- **修复只读 shell 误判重定向**：`--format='%h %an <%ae>'` 这类引号内的 `>`、`2>&1` 文件描述符复制、`>$null` / `>/dev/null` 空设备都不再被当成写文件；真正的 `> out.txt` / `>> log` 仍然拦截。
- **修复只读 shell 误切管道**：命令分段改为引号感知，`Select-String -Pattern 'a|b'`、`rg "x||y"` 不再被拆成两段而拒绝；真实管道 `cat f | wc -l` 仍逐段校验。
- 面向 GitHub 发布：补 `license` / `author` / `repository` / `homepage` / `bugs` / `keywords`，新增 `.gitignore`、`.gitattributes`、`LICENSE`、本文件。

## 2.9.10

- `transcript-window` 改用 `ctx.inject(['sessionController'], …)` 等服务就绪后挂载；注入失败落 journal，不再静默失效。
- **CODE_STATE 去掉 git HEAD 分量**：只绑文件内容快照（排除工作区根部 `doc/`）。`doc/` 的写入与提交都不再让放行失效；提交号只在 `status` / `doctor` 展示，标注「不绑定」。
- **陈旧 pending**：用 `process.uptime()` 反推进程启动时刻，`pending.sentAt` 早于它即判「上个进程遗留」——`status` 标注、`wait` 立即返回 `kind=stale`、`say` 允许覆盖，重启后不再被卡住。
- `doctor` 分级：窗口未挂载等「配置期望未满足」记 WARN；FAIL 只留给真故障（挂载指向别处、状态文件不可写/写错误）。
- 文案收尾：新增 40+ 条 key（zh-CN / en 对齐），say / cancel / pending / roster / goal / approval / command 全部走 `messages.js`；「disposed」等内部术语下沉。
- `doctor` 版本一致性自检：比对 profile 安装版本 / 磁盘 `package.json` / 运行中 `PLUGIN_VERSION`，不一致提示「重启后生效」。

## 2.9.9

- **修好 15 轮历史窗口**：旧实现把 `turnWindow.minTurns`（宿主语义是「最小值」）当上限抬，方向反了，所以一直「没效果」。改为向下压 `maxMessages` / `minTurns` / `minMessages`，默认 15 个 turn、单页上限 34 条；默认启用。
- 生效参数挂到 `sessionController.__transcriptWindowConfig`，`status` / `doctor` 显示真实数字；`debug: true` 时把真实请求的前后参数写到 `~/.dsh/commander/transcript-window.log`。

## 2.9.8

- 状态持久化改自有文件 `~/.dsh/commander/state.json`（宿主 `storage.form('kv')` 在只挂 `domain` 的宿主上必然抛错并静默降级内存，重启就丢）。
- 新增 `state-store.js`：原子写、目录 `0700` / 文件 `0600`、跨进程锁（拿不到锁不覆盖）、损坏隔离 `.broken-<ts>`、表修剪、旧版本迁移。
- 新增 `commander(action="checks")`：受控检查命令白名单，超时整组进程杀掉、输出截断、并发 1。
- 新增 `/commander doctor`：安装 / 运行态 / 持久化 / 门禁 / UI 窗口 / 环境，PASS/WARN/FAIL + 下一步。
- `status` 暴露当前 `CODE_STATE`；`wait` 放行时附「本请求绑定的代码状态」。
- 新增 `messages.js`：zh-CN 全量 + en 兜底，缺 key 显式报错。

## 2.9.7

- 按云端可用性审计修复 P1×3 + P2×9：持久化不再静默降级、goal 批准被消费后 `update_goal` 幂等、`CODE_STATE` 解析真实提交号（2.9.10 起改为不绑 HEAD）、`/commander` 空参数只显示用法、决定行允许尾部说明、只读 shell 白名单扩容、门禁标志只在成功后置位、`doc` 只排除根部。

## 2.9.6

- 撤掉 2.9.5 的硬编码 goal 空转保护，改为协议：需要用户输入时由主agent上报、指挥员下令「暂时作结」。

## 2.9.5

- （已撤销）按轮数自动 block 空转 goal 的硬编码守卫。

## 2.9.0 – 2.9.4

- 指挥员模式成形：可续接 teammate、`say/wait` 无超时等待、决定令牌、放行绑定代码状态、goal 审批、中断恢复、斜杠命令收自由文本与中文别名、拼错子命令提示。
