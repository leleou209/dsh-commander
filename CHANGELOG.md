# 更新日志

版本号与 `package.json` / `index.js` 里的 `PLUGIN_VERSION` 一致；`/commander status` 首行显示运行中的版本。

## 3.0.1

发布版：**2.9.41 → 2.9.62 的合并发布**（上一个对外版本是 2.9.40）。
逐条细节见下面各节；这里只列对外可见的行为变化与升级须知。

### 行为变化（用户能感知）

1. **初始化只做三件事**：建立并绑定本会话的指挥员、让它预热（读 doc 四件套）、落地默认挡位 `observe`，然后**停住**。草稿投递、自动 goal、自动契约同步全部删除。
2. **初始化不再让主会话自动开工**：宿主那条「子agent 完成即唤醒父会话」的推送已用 `delivery:'caller'` 关掉（根因在宿主 `dsh-subagent`，插件侧改不动）。
3. **图标只在主会话出现**：子会话首帧就不渲染（宿主 slot 的 `useSession`/`useSessions` 同步判定），服务端 `canControl` 在指挥员空闲时也能判。
4. **图标看得见预热的进度与代价**：转圈 → 皇冠；tooltip 给出 秒 / 步 / 工具次数 / 新 token（缓存命中单列）。
5. **接管挡位跨进程保存**：按根会话记，重启后恢复；状态文件 schema 4 → 5。
6. **退出全接管立即叫停**：在途等待到达的指挥员回复不再唤醒主 agent。
7. **goal 联按参与级别分派**：弱→弱（初始化落地、重复点「不接管」）零 goal 操作，强→强不重复覆盖。

### 升级须知

- 客户端半有改动 → **刷新一次页面**（Host 侧可热载）。
- 状态文件自动迁移（schema 4 → 5，`takeover` 表重新启用），无需手工处理。
- `PLUGIN_VERSION` 与 `package.json` 必须同步（doctor 的「安装」行会比对运行中版本与磁盘版本）。
- `package.json` 的 `files[]` 已补入 `lib/preheat.js`、`lib/takeover-store.js`（打包遗漏会让插件加载失败）。

### 测试

17 套全绿（`node test/*.mjs`）、`node --check` 全通过、`test/style.mjs` 6/6（行数棘轮仍由历史基线守护，`index.js` 3115 行）。

## 2.9.62

一句话：**初始化给一个看得见的就绪信号，并明码标出代价**（几秒 / 几步 / 几次工具 / 多少 token）。

### 为什么必须加

2.9.58 拿掉宿主那条完成通知之后，指挥员预热完成**在主会话里不留任何痕迹**：
我没有新气泡、没工具调用、没提示。用户实测后的结论就是"新会话根本不会创建指挥员"——
而日志显示 03:41 那次它 5 秒内就建好并跑完了（`subagent/catalog` + 子会话 `turn/end completed`）。
**功能是对的，可见性是零。** 这是"不唤醒"必须付的代价，得用别的方式补回来。

### 改法

1. **`lib/preheat.js`（新）**：只读地从指挥员自己的会话日志算"预热代价"——
   `summarizePreheat`（纯函数：创建时刻→首个 `turn/end`、步数、工具调用数、token）+
   `createPreheatTracker`（按指挥员会话 id 读，跑完即缓存；拿不到会话就返回 `undefined`，
   **宁可什么都不显示，也不编数字**）。token 分三类报：`inputTokens`（新输入）/
   `outputTokens` / `cacheReadTokens`（命中缓存，便宜但不为零），避免把缓存命中说成"花掉"。
2. **图标路由**多返回一个只读字段 `preheat`（不投递、不进收件箱、不唤醒）。
3. **客户端**：预热进行中**继续转圈**（不再提前变皇冠）；tooltip 分四段文案——
   未初始化（先讲清代价与边界）、预热中、已就绪（带实测代价）、失败。
   文案一律不改 composer 布局（只改 title / aria-label / 图标形态）。

### 实测（03:41 那次真实预热，跑在 2.9.61 上，用本模块回放同一份日志）

```
指挥员已就绪（预热 5s / 2 步 / 5 次工具 / 44.2k token / 缓存命中 271.4k，本会话零打扰）— 点击选择接管挡位
```

即一次初始化的真实代价：**约 5 秒、2 个模型步骤、5 次工具调用、44.2k 新 token
（另有 271.4k 前缀缓存命中）**。

### 测试

17 套全绿。`init` 11 → 12（`summarizePreheat` / `sumPreheatTokens` 的真值表：running/done/failed、
缺 usage 不炸、空事件返回 undefined）；`client-render` 10 → 13（就绪带代价 / 进行中转圈 /
未初始化先说清代价）。

## 2.9.61

一句话：**退出全接管后，还在路上的那条指挥员回复不再点燃主agent。**

### 根因

`driveHandoff` 在**本轮 turn/end** 那一刻按当时的挡位决定交接，然后 `waitCommanderGuarded` 可能要等很久
（20 分钟上限）。等待期间用户完全可能把挡位从「全接管」切走 —— 那条迟到的回复照样走到
`wakeWithInstruction → agent.followup`，把主agent 叫起来开一轮。这轮对话早就不归指挥员开了。

这正是指挥员 `agent.md` 里那条口径没落实的部分："退出 full 立即叫停，在途等待不得再唤醒主 agent"。

### 改法

- `lib/handoff.js` 新增 `shouldWakeParent({takeover, stopped})`：**唤醒前再读一次当前挡位**，
  不是 `full` 就不唤醒；插件停运（`stopped`）是硬闸；读不到挡位一律不唤醒。
- `lib/handoff-driver.js` 在 `wakeWithInstruction` 前加一行守卫。工厂函数已顶在 281 行基线，
  所以同处删掉一个函数间空行，净增 0 行。

### 语义边界

- 只影响"唤醒"这一步：等待、看门狗、pending 清理都不变（`waitCommander` 自己清 pending）。
- 退场后迟到的回复被丢弃，不再进入主会话；指挥员的原文仍在它自己的会话里可查。
- 反向不受影响：真正处于全接管时的正常交接照旧。

### 测试

17 套全绿。`handoff` 20 → 21（`shouldWakeParent`：observe/partial/off 不唤醒、full 唤醒、
`stopped` 硬闸、缺挡位不唤醒）。

## 2.9.60

一句话：**挡位跨进程保存**（用户改口径）；顺带把 goal 联动改成"按参与级别分派"，弱→弱一个 goal 动作都不发。

### 口径变更

2.9.19–2.9.59：挡位是纯内存态，重启回 `observe`（当时的理由是"上一次的 full 不该在新进程里复活"）。
2026-11-15 用户改口径：**挡位要保存**。落地方式：只存挡位，不碰 goal。

### 改法

1. **`lib/state-store.js`**：`takeover` 表重新进 `STATE_TABLES`（schema 4 → 5）。
   这张表本来就在（2.9.19 前用过、之后退役，`test/state-store.mjs` 里还有一条"退役表不许复活"的断言）；
   现在它是活的，旧文件里的行按同形字段直接可用。
2. **新增 `lib/takeover-store.js`**：`createTakeoverStore({map, unit, log})` ——
   `ready()` 把磁盘灌进内存 Map（幂等，只灌一次；内存里已有的值不覆盖），
   `set()/delete()` 双写（先改内存让同步读路径立刻看到，再异步落盘，失败只记日志）。
   读路径仍是同步的，所以 store **持有**那个 Map，`currentTakeover` 一行没改。
3. **`index.js`**：`setTakeoverOverride` 改走 store；三个异步入口（图标路由 / `applyTakeoverChange` /
   `commander` 工具）先 `await takeoverStore.ready()`；apply 一开始就 `void ready()` 预热，
   因为 goal 门禁那条是同步路径，等不了 await。
4. **goal 联动按参与级别分派**（采纳指挥员 `agent.md` 的口径）：
   新增 `shouldSyncGoal(before, after)`（`lib/goal-link.js`），只有 强↔弱 才动 goal。
   weak→weak（初始化落地、重复点「不接管」、HMR 丢内存后再点 ?）**零 goal 操作**；
   强→强也不重复覆盖（模板只在**进入**强参与时打一次）。
   旧值取"生效中的挡位"（`override ?? DEFAULT_TAKEOVER`），不是 `undefined`。

### 副作用说明

- 恢复 `full` **不会**凭空开一次交接驱动；但之后正常的 `turn/end` 会按 full 交接——那就是全接管的含义。
- goal 不会被复活或续跑（`goal` 表没动，paused 仍需用户手动 resume）。

### 测试

17 套全绿。`takeover` 16 → 18（持久化：ready 灌盘 / 脏数据丢弃 / 内存不被覆盖 / set 双写 / delete 清除；
磁盘读失败只记日志）；`goal-link` 12 → 13（`shouldSyncGoal` 的 4 类组合）；
`state-store` 那条"退役表"断言改写为"2.9.60 起旧文件里的挡位读得进、也写得回"。

> 本次客户端**无改动**；服务端改完重启即可。

## 2.9.59

一句话：**重启后图标不再把指挥员当成不存在（冷缓存兜底）；子会话图标的服务端兜底也补上了指挥员 id 这一道。**

### 根因（重启后的现场）

2.9.58 重启后用户报「图标不认指挥员了」，图标画成问号（phase=`none`）。

证据：

| 时刻（本地） | 事实 |
| --- | --- |
| 01:49:29 | 宿主主进程启动（2.9.58） |
| 01:50:35.7 | 客户端模块加载（probe `load`） |
| 01:50:37.6 | 客户端首次 `ready`（`hasSession:true`） |
| ~01:50:37 | `GET /commander/takeover` 回 `hasCommander:false, phase:"none"` → **问号** |
| ~01:56 | 我跑了 `commander(action="status")`（内部会刷新成员缓存） |
| 之后 | 同一个 GET 回 `hasCommander:true, phase:"ready", state:"observe"` |

原因：`commanderExists()` 只读**同步缓存**（`teamService().listMembers`），而缓存是内存里的，
重启即空。图标路由从不主动刷新，于是重启后第一个 GET 必然说"没有指挥员"。
`hasCommander:false` 又会把 `phase` 拉成 `none` → 问号。

（顺带说明：接管挡位本来就**不跨进程**，重启后回到 `observe`／推导，这是 2.9.47 起的既定口径，
不是这次的 bug。）

### 改法

1. **`lib/team.js` 新增 `ensureCommanderKnown(bridge, agent, commanderName, options)`**：
   缓存里没有指挥员时补一次**有界**（默认 1.5s）刷新——指挥员的会话 id 记在父会话日志的
   `subagent/catalog` 里，`listDescendants` 读得回来。超时就不等（按缓存答，客户端 8 秒后再问）；
   对"探测过还是空"的根会话记 15 秒负缓存，避免每轮 8 秒都打宿主。
2. **图标路由先补刷新再答**（`await ensureCommanderKnown(teamService(), agent, config.commanderName)`）。
3. **`canControl` 兜底补一道**：会话头读不到时，除 fail-open 外再排除**已知指挥员 id**
   （`commanderIds`）——指挥员空闲时 residency 已释放、`agents.get` 与 `sessions.get` 都可能拿不到，
   之前的 fail-open 就把它当主会话了。

### 测试

17 套全绿（`team` 12 → 13：热缓存不打扰宿主 / 无 agent 不打扰 / 冷缓存刷一次 / 负缓存 15 秒内不重复 /
过期后重新探测）。

> 客户端本次**无改动**，服务端改完重启即可；重启后刷新一次页面。

## 2.9.58

一句话：**初始化彻底不会点着主会话了——拿掉宿主的「子agent 完成即唤醒父会话」推送；子会话不再出现图标；初始化不再误暂停 goal。**

### 根因（宿主层证据）

2.9.57 删掉了插件自己的投递，但用户那边"初始化一结束主会话就自己开工"仍然复现。查宿主 `dsh-subagent`：

```
notifySettlement(activation, terminal)                       // lib/types/manager.js
  if (!activation.accepted || activation.delivery === 'caller') return
  const message = createSettlementMessage(...)               // source.kind = 'subagent-settled'
  this.sendWaking(parent, message, parent.status === 'idle' ? 'queue' : 'steer')
```

`spawnTeammate` 一直传 `delivery: 'parent'`，于是指挥员**每轮结束**都会往主会话收件箱塞一条
`subagent-settled` 并**开新一轮**。铁证（本次会话日志，UTC）：

| 时间 | 会话 | 事件 |
| --- | --- | --- |
| 16:48:43.567 | 子 `7e26db4a`（指挥员） | `session` 创建开始预热 |
| 16:56:00.581 | 子 `7e26db4a` | `turn/end completed`（43 步、68 次工具调用） |
| 16:56:00.609 | 主 `session-03213ddf` | `agent/inbox/spliced` + `turn/start`（**28ms 后**） |
| 16:56:00.6xx | 主 | 收 `user/message`，`source.kind='subagent-settled'`，正文"Background subagent commander finished…" |
| 16:56:2x | 主 | 主agent 开始"List workspace and plugin directory"/`glob dsh-commander/**/*.js` → 用户 `turn/end aborted(user)` |

主会话里没有任何 `source.kind='user'` 的消息，却跑了一轮——唯一触发源就是这条完成通知。

### 改法

1. **`spawnTeammate` 默认 `delivery: 'caller'`**（`lib/team.js`）。caller 投递不产生完成通知，
   父会话不会被唤醒；成员仍进 catalog（名字、`listDescendants`、续接、工具面收紧都不受影响）。
   指挥员的回复本来就由插件自己的握手取（pending + 指挥员会话的 `assistant/message`），
   不依赖这条推送，所以只是**拿掉自动唤醒**。需要旧行为时可显式传 `{ delivery: 'parent' }`。
2. **子会话不显示图标，且首帧就判出来**（`lib/client.js`）：新增 `TakeoverSlot` 外壳，用宿主
   session 作用域槽位的标准 props 同步判定，判据照抄宿主 `TeamModeToggle`
   （`useSession(s => s.subagent != null)` / `useSessions(s => s.byId[id].origin === 'subagent')`）。
   之前靠 `/commander/takeover` 的 `canControl` 兜底有两个窟窿：首帧还没快照就先画皇冠、
   fetch 失败就永远拿不到 canControl。服务端同时补上：指挥员空闲时 residency 已释放、
   `agents.get()` 拿不到，改为回退 `sessions.get(sessionId).header` 判 `parentSession`。
3. **初始化不再误暂停 goal**：init 分支的 `setState` 原来走 `applyTakeoverChange` —— 那条路会
   （a）拿 `takeoverOverrides.get(id)?.state` 当旧值，没有覆盖值时它是 `undefined`，于是把
   "落地 observe" 判成一次切换并写接管通知；（b）无条件 `syncGoal('observe')` → 弱参与分支
   → `goals.pause()`，把用户正在跑的 goal 静默暂停（paused goal 模型无权 resume，只能用户手动恢复）。
   现在 init 只落地挡位：`setTakeoverOverride(sessionId, state, 'init')`，**不写通知、不碰 goal**，
   source 记为 `init`（界面显示"启动默认"）；用户自己切挡位仍走 `applyTakeoverChange`，语义不变。

### 测试

17 套全绿。新增/改写：`team` +1（delivery 透传矩阵，原断言 `'parent'` → `'caller'`）、
`client-render` +3（子会话首帧不渲染、origin=subagent 不渲染、主会话不被误伤）、
`init` 10 → 11 项（静态断言：init 分支不得调用 `applyTakeoverChange`、必须 `setTakeoverOverride(…,'init')`；
另加一条守 `lib/team.js` 的 delivery 默认值）。

> 客户端半有改动（新增外壳组件），**必须刷新一次页面**；服务端经热载生效。

## 2.9.57

一句话：**初始化只做"建立+绑定、预热、落默认挡位"，然后停住；删掉草稿机制、自动 goal、自动契约同步与主会话投递。**

### 根因（用户口径）

初始化被做成了"用输入框草稿开工"：`buildInitMessage` 把用户随手打的字包装成 *开局目标* 投递给主会话，
于是主会话立刻开工；同时 `start` 分支 `applyGoalPolicy` 自动建 goal、建成员时自动发 `[契约同步]` 让指挥员多跑一轮。
即使选"不接管"，这几条自动行为也照跑——**初始化变成了自动连续行为的起点**。

### 改法

1. **删掉草稿机制**（按用户指示）：`clampDraft` / `DRAFT_LIMIT` / `buildInitMessage` / `createInitDelivery`
   全部删除（`deliver/flush` 与 `turn/start` 的补发钩子一并去掉）；客户端 `readComposerDraft` 删除，
   初始化请求只发 `{sessionId, init:true}`。
2. **初始化不建 goal**：`start` 分支去掉 `applyGoalPolicy`，回执改为「goal：未创建（等用户下达任务）」。
3. **初始化不发契约**：建成员时的 `[契约同步]` 自动投递删除（契约常量与手动入口保留）。
4. **提示词从"披露式快照"降为"文件清单"**：四大件只给 `路径 + 一句角色`，正文由指挥员自己 `read`；
   并明确写「读完只回一句初始化完毕就停；不要开工/提方案/改文档/动 goal；模式与任务由用户随后决定」。
   提示词 4,854 → **1,629 字符**（其中文档部分由约 3,000 字符降到 4 行）。
5. **保留**：初始化后落默认挡位 `observe`（随后由用户自己调节）、相位表、图标三态、探针、覆盖度判定。

### 语义边界（写进代码注释与测试）

- 没有指挥员时初始化：**不使用草稿**、不建 goal、不发契约、不投递主会话，只建成员 + 预热。
- 已有指挥员时：草稿机制已删，切挡位只切挡位；任务由用户发言下达。

### 测试

17 套全绿（`init` 重写为 10 项：三态/相位/planInit/startWithPhase/runInitFlow 无投递/无草稿/无 goal/无契约的静态断言；
`guards` 宿主 signal 门禁 4→3 处；`offline` 的 start 断言改为「不建 goal」）。

> 客户端有改动（按钮文案与请求体），**刷新一次页面**即可；服务端经热载生效。

## 2.9.56

一句话：**补完 2.9.55 的两件收口——挡位切换路径的相位落账、客户端自证探针（最小版）；不加新功能。**

### 1. 挡位切换路径的相位落账（P2，2.9.55 遗留）

`POST /commander/takeover` 选「运行职责」的挡位时若指挥员还没起来，会顺手启动；但响应里的 `phase`
是**启动前**算的 `none`，客户端最多显示 8 秒问号，而 goal 已经被接管。

- 启动改走 `startWithPhase({ start, tracker, id: rootSessionIdOf(agent) })`：成功即 `ready`、失败即 `failed+lastError`。
- `stateJson()` 里的 `phase` 改为**响应时现算** `phaseTracker.phaseOf(...)`，不再用闭包里启动前的常量。

### 2. 客户端自证探针（最小版）

- `POST /commander/client-probe`（挂在既有 `/commander/takeover` 前缀下，不新增路由注册）：
  ≤4KB、只收白名单字段（`event`/`sessionSource`/`error`/`hasSession`），**不记任何会话内容**；
  落 `~/.dsh/commander/client-probe.jsonl`，环形 **200** 行；`GET` 回最近 **20** 条。
- **降级不报错**：目录不可写 → 内存环形 + 一条 warn，路由永远 200，绝不 500。
- 客户端上报 `load` / `ready` / `fetch-error`（`render-error` 由宿主侧扩展保留，client 已具备统一入口）。

### 测试

17 套全绿（新增 `test/probe.mjs` 3 项；`regressions` 15→16 增「响应现算相位 + 启动走 startWithPhase」静态回归）。

> 与 2.9.55 合并为**一次重启**；核对项见 `doc/RESTART-CHECK-2.9.56.md`。

## 2.9.55

一句话：**修掉 2.9.54 引入的 3 个 P1（子会话整槽崩 / canControl 误藏 / 启动失败不落账）+ 2 个 P2，并把「验证工具自身的可信度」做成可判定。**

### 缺陷与改法（先红后绿，证据见 doc/verify/2026-11-14-2.9.55/）

1. **条件式早退插在 hooks 之间**（P1）——`lib/client.js` 的 `if (snapshot?.canControl === false) return null`
   原本在 3 个 `useEffect` 之前：子会话首次渲染正常、第二次渲染少调用 hooks，
   React 报 `Rendered fewer hooks than expected` → **整个 composer 槽位崩**。
   改法：早退移到**所有 hooks 之后**（仍不回显按钮）。测试：`client-render` 第 5 项（旧 9→6，新 9→9）。
2. **`canControl` 取不到就判 false**（P1）——`agents.get(sessionId)` 空时根会话也被隐藏。
   改法：取不到会话时 **fail-open = true**（宁可显示，不可误藏）。测试：`client-render` 第 6 项。
3. **启动失败不落账**（P1）——init POST 里 `markStart` 后 `startCommanderFromUi` 抛错直接 500，
   相位停在 `provisioning` 直到 90s 超时。改法：新增 `startWithPhase()`（`lib/init-flow.js`），
   失败 `markFailed(id, message)` 后原样抛出；路由只留一行。测试：`init` 第 13/14 项。
4. **failed 点击走菜单**（P2）——CHANGELOG 2.9.54 写的「点击重试」与代码不符。
   改法：`phase==='failed'` 也走 `startInit`，`badgeTitle` 增「初始化失败，点击重试」。测试：`client-render` 第 7 项。
5. **验证工具覆盖**——新增 `lib/coverage.js` + doctor 行「环境 / 检查覆盖」：
   配置的检查项覆盖不到 `test/*.mjs` 全集即 **FAIL** 并列缺项，不再拿子集给「全绿」背书。
   live `checkCommands` 10 → **16**（改前备份 `cordis.patch.yml.bak-2.9.55`）。

### 约束遵守

- style 棘轮**零增长**：`index.js` 3116 / `apply` 2475 / `TakeoverBadge` 215 / `doctorReport` 178 / `createDoctor` 234，
  全部恰好等于基线（靠「逻辑外移 + 等量行替换」实现，没有上调任何基线）。
- 新增模块 `lib/coverage.js`、`test/coverage.mjs` 已进 `package.json.files`（`npm pack` 49 files，逐一核过）。

### 测试

16 套全绿（新增 `coverage` 1 套；`init` 12→14、`client-render` 4→7）。

> 重启后生效；重启核对项见 `doc/RESTART-CHECK-2.9.55.md`。

## 2.9.54

一句话：**初始化改成显式相位表（绑定成功即就绪），修掉旋转圈永不解除；子会话不再显示按钮（纯显示，不做权限）。**

### 现象（用户实测）

点问号初始化后：goal 已被接管、消息也发给主 agent 了，图标**还在转圈**，永远不会变回皇冠。
用户判断「初始化未完成就接管 goal 并发话」，并指出这暴露了**没有足够的验收设计**。

### 根因（两层，都不是"初始化没做完"）

1. `phase` 是从 `agent.status` 反推的：`running` 被当成 provisioning。绑定其实早就成功，
   而 teammate 在跑首轮提示词时一直是 running → 永远 provisioning。
2. 客户端在 init 成功后**乐观置位** `phase='provisioning'`，之后每轮轮询又被服务端同样错的相位覆盖。

### 改法

- 新增 `createPhaseTracker`（`lib/init-flow.js`）：显式表 `{phase, startedAt, readyAt, lastError}`，
  **只由事件转移**：点问号 markStart → 绑定成功 markReady → 90 秒未就绪自动 failed（带 lastError）。
  **禁止从 agent.status 反推**。老会话无记录时按「有没有指挥员」兜底。
- 顺序纠正为 **绑定 → ready → 再联动 goal / 投递草稿**：`start` 成功返回后立刻 `markReady`，
  之后的 `setState`（goal 覆写）和 `deliver`（发给主会话）都在就绪之后发生。
- 客户端去掉乐观置位，相位以服务端为准；`failed` 显示红色问号（点击重试），provisioning 才转圈。
- **子会话不显示按钮**：`GET /commander/takeover` 返回 `canControl`（是否根会话），
  客户端直接 `return null`。这是**显示判断，不是权限层**（按用户要求，没有新增任何权限门禁）。

### 测试

`test/init.mjs` 保留 12 项，其中相位用例改为「start→provisioning，绑定后立刻 ready，90 秒→failed，
老会话兜底」；`client-render` 4 项。15 套全绿；`index.js` 3113 行（≤3116）；style 6/6。

### 未完成（下一批）

- 图标可见性证据化（client-probe：load/ready/render-error/fetch-error + 环形日志），
  这样"图标在不在"不靠猜；
- 线上 profile 的 `checkCommands` 只有 10 条，仓库 15 套测试 → 补到 15 条 + doctor 校验；
- 2.9.49–2.9.54 的证据包与重启卡统一补发。
## 2.9.53

一句话：**改成披露式快照，首轮注入压到 4,854 字符（原来约 19k）；按用户要求去掉自造记号与守卫测试。**

### 按用户口述改的三件事

1. **不要守卫** —— 删掉 `test/prompt-budget.mjs`（以及 package.json 里的登记）。
   预算这件事用"披露式"约束，而不是用测试把数字钉死。
2. **5K 以上就算长** —— 目标是单次初始化 < 5,000 字符，实测 **4,854**
   （提示词 4,419 + 契约 435）。本轮之前是 6,178，上一版是 ~19,000。
3. **不要自造记号** —— 提示词与快照改成纯分段叙述：
   - 去掉 `##` / `###` 标题与 `**加粗**`，改用"某某："开头的一行加 `-` 列表；
   - 去掉 `【】` 方括号标记（接管模板的 `【接管：…】` 属消息正文，不在提示词里，未动）；
   - 保留 `-` 与必要的代码标识（`` ` ``、路径），因为那是可直接执行的指令，不是装饰。

### 披露式快照怎么工作

每份文档只给开头一段 + 规模 + 小节名，例如：

```
doc/plan.md 当前计划：13500 字符；小节：第 18 轮 · …
（开头 700 字符）
（后面还有 12800 字符，用 read 读全文）
```

四份合计 **3,033 字符**（suggest 758 / agent 637 / plan 824 / history 814）。
要细节就 `read` 读文件——截断不等于信息丢失，指挥员本来就有读权限。

`maxSuggestChars` 等四个配置项仍然有效（默认 700 / 700 / 700 / 500），改为控制"披露多少"。

### 测试

15 套全绿（原 16 套里撤掉 prompt-budget）；`index.js` 3111 行（≤ 3116）；style 6/6。

> 与 2.9.50–2.9.52 一起重启生效。
## 2.9.52

一句话：**把初始化成本砍掉约 2/3 —— 快照默认预算 14k→4k 字符，契约同步从 2.5k→0.9k 字符。**

### 现象（用户实测）

一次初始化让指挥员吃到约 **20k token 未缓存输入**（¥50/M 级别，一次就好几毛）。同一会话后续轮次能命中缓存，
但首轮这笔是实打实的。

### 钱花在哪（实测字符数）

| 来源 | 旧默认 | 说明 |
|---|---|---|
| `doc/suggest.md` 快照 | 4,000 字符 | 整篇截断 |
| `doc/plan.md` 快照 | 3,000 字符 | 1 段 |
| `doc/history.md` 快照 | 4,000 字符 | **6 段**（本文件 83.7KB，6 段能吃掉几万字符） |
| `doc/agent.md` 快照 | 3,000 字符 | 1 段 |
| 契约同步消息 | 2,530 字符 | 完整 `COMMANDER_CONTRACT` |
| 提示词模板 | ~2,300 字符 | 硬格式/硬规则/优先级等 |

合计约 **19k 字符**（中文≈1 token/字），正好对上用户看到的 20k。

### 改法

1. **快照预算收紧**：`maxSuggestChars 4000→900`、`maxPlanChars 3000→1200`、
   `maxHistoryChars 4000→1200`、`maxOrientationChars 3000→700`、`historySections 6→1`
   —— 四份合计 **14,000 → 4,000 字符**（配置项仍然可调，只是默认变省）。
2. **契约同步用精简版**：新增 `COMMANDER_CONTRACT_BRIEF`（900 字符；决定行、请求号回显、
   放行五段、goal 批准、只指挥不实现、骨肉优先），首次同步只发它；
   完整契约（2,530 字符）仍导出、仍可查，细则指向 `COMMANDER-GUIDE.md`。
3. 提示词里明写「快照按成本预算截断，要看全文用 read 读文件」——截断不等于信息丢失（指挥员有读权限）。

**新预算**：快照 4,000 + 契约 900 + 模板 2,300 ≈ **7.2k 字符**（约 6–7k token），比原来省约 2/3。

### 测试

新增 `test/prompt-budget.mjs`（**5 项**）：精简契约必须 <1.2k 且保留五段格式要点、模板本身 <4k、
快照默认预算 = 4,000、大文档场景首轮注入 ≤8,000 字符、提示词必须声明"按成本预算截断"与"用 read 读全文"。
**16 套测试全绿**；`index.js` 3115 行（≤ 3116）。

> 与 2.9.51 一起重启生效；之后想更省可以继续调这四个 `max*Chars`（配置项，不用改代码）。
## 2.9.51

一句话：**图标还是不见 —— 因为 2.9.50 的「等拿到快照才渲染」把图标绑在了 fetch 成功上。**

### 现象

重启到 2.9.50 后，composer 右侧依然什么都没有（截图确认：只有 `+`、完全权限、模型选择器、发送键）。

### 根因（第二层）

2.9.50 修了 TDZ，但顺带加的「首帧 `snapshot === null` 就 `return null`」把渲染**绑死在第一次
`GET /commander/takeover` 成功**上。只要这次 fetch 失败（sessionId 缺失、路由 4xx、时序），
`snapshot` 永远是 null → 组件永远返回 null → 图标永久消失。而 2.9.47 之前是先画皇冠、
再拿数据着色的，所以旧版即使 fetch 失败也看得见。

### 修法

- **首帧按 `ready` 画皇冠**（恢复 2.9.47 之前的可见性），拿到快照后再切问号 / 旋转圈；
- `sessionId` 兜底：`props.sessionId ?? props.session?.id ?? props.session?.header?.id`
  —— 槽位在不同版本给的东西不一样，取不到就是 `fetch(...?sessionId=undefined)` → 400 → 永远没图；
- 保留三条 `console.warn('[dsh-commander] …')`（读状态/切挡位/初始化），失败原因直接进控制台。

`test/client-render.mjs` 3 → **4**：新增「首帧必须渲染出图标（不能依赖 fetch 成功）」与
「sessionId 缺失时用 session 对象兜底」两条断言；原来那条「首帧应返回 null」的断言按新口径改写。

> 15 套测试全绿；`index.js` 3114 行（≤ 3116）。**仍需重启进程**（客户端在宿主启动时读取）。
## 2.9.50

一句话：**修「图标整个消失」——`fast` 的 TDZ 让客户端组件渲染直接抛错。**

### 现象

重启到 2.9.49 后，composer 右侧的指挥员入口**完全不见**（连皇冠都没有），而宿主的
`GET /commander/takeover` 仍然 200 且返回 `phase:"none"` —— 说明宿主侧正常，是**客户端组件崩了**。

### 根因

2.9.48 给轮询加「provisioning 时 1s」时，把 `const fast = phase === 'provisioning'` 写在
`React.useEffect` **之后**，而依赖数组 `[sessionId, fast]` 在渲染时就要求值 → 命中
`Cannot access 'fast' before initialization`（TDZ）→ 组件渲染抛错 → 整个槽位不渲染。

`node --check` 只能证明语法，**测试全绿也抓不到**——这是这次真正的教训。

### 修法

- `phase` / `fast` 提到组件顶部（紧跟 `useRef`、在所有 `useEffect` 之前）。
- 首帧（`snapshot === null`）直接 `return null`，避免"先画问号再跳成皇冠"的闪烁与误导。

### 新增回归守卫

`test/client-render.mjs`（**3 项**）：用最小 React/window/document stub 把 `lib/client.js`
真正加载一次并**调用组件**：
1. 模块加载器能跑通并注册到 `conversation.input.right`；
2. 首帧（state=null）不抛错 —— TDZ 这类渲染期错误会被抓；
3. `phase='none'` 的快照能画出问号。

> 15 套测试全绿；`index.js` 3114 行（≤ 3116）。

**生效方式纠正**：客户端源码是宿主**启动时**读取/组装的，只刷新页面拿不到新代码 ——
`lib/client.js` 的改动同样需要**重启进程**（实测：20:18 那次重启加载的是 2.9.49 的带 bug 客户端，
所以刷新无效）。

另给三条失败路径加了 `console.warn('[dsh-commander] …')`（读状态 / 切挡位 / 初始化）：
图标不出现时按 F12，控制台第一条就能定位，不用再猜。
## 2.9.49

一句话：**名字分层（决策托管 / 指挥员 / 插件）+ 给指挥员加一条「骨肉优先于皮肤」的硬口径。**

### 1. 命名分层（只改文字，不改任何标识）

- README 标题改为 **「决策托管（dsh-commander）」**，首段给出定义：把「下一步做什么、做到什么算完成」
  的判断权按挡位托付给一个长期在线的指挥实体；执行者是**指挥员**，打包形态仍是**插件**。
- 新增 `doc/NAMING.md`：三层名字（能力=决策托管 / 实体=指挥员 / 形态=插件）、托管强度与四挡位对应表、
  以及**刻意不改**的清单（工具名 `commander`、包名、`state.json`、`commander-takeover-*` 消息 id、
  `dsh-commander:` 日志前缀）。
- `package.json` 的 `description` 前置「决策托管（dsh-commander）：」。

### 2. 指挥员新增优先级口径（骨肉优先于皮肤）

加在 `lib/protocol.js` 的 `COMMANDER_CONTRACT`、`lib/prompts.js` 的常驻 prompt、`COMMANDER-GUIDE.md` 三处：

- **骨肉** = 核心功能正确性 + 架构骨架（模块边界/数据流/扩展点）+ **可量化的性能硬指标**
  （延迟/吞吐/内存/冷启动/帧时间，写具体数字与测量命令）。
- **新架构型项目的第一批必须是「骨架跑通 + 指标达标」**，未达标不得进入打磨。
- 安全加固 / 兼容补丁 / 体验打磨是**皮肤**：只在①有实证风险 ②直接阻塞骨肉 时插队。
- 批次里必须**显式写架构**，禁止「按最佳实践实现」「注意性能」这类空话。
- **允许激进**：可为指标做破坏性重构、换实现、砍旧路径，但必须同时给回滚点、验收口径与不可接受的副作用。
- 提问顺序：先问「能不能支撑 10 倍量 / 更严指标」，再问「代码风格好不好看」。

`test/offline.mjs` 增加 3 条断言（prompt 里必须有「骨肉优先于皮肤」「性能硬指标」「回滚点」）。

> 14 套测试全绿；`index.js` 3114 行（≤ 3116）；与 2.9.48 一起重启生效。
## 2.9.48

一句话：**不覆写已经完成的 goal**（2.9.47 实测暴露的边界）。

### 现象（2.9.47 实机验证时发现）

切到「部分接管」时，会话里已有的 goal 处于 `phase=complete`。2.9.47 的 `planGoalSync`
在强参与分支没有拦 `complete`，于是尝试 `goals.edit` 一个已结束的目标 —— 宿主拒绝，
日志里只剩一条 `goal 联动失败` 的 warn，接管状态正常（设计如此，不回滚）。

### 修法

强参与分支加一条前置判断：

```js
if (goal !== undefined && goal.phase === 'complete') return { action: 'none', reason: 'phase-complete' }
```

配合原有规则：`paused` → 只覆写 + `needsResume`（模型无权 resume）；`complete` → 一律不动。

`test/goal-link.mjs` 11 → **12**（新增「已完成的 goal + 强参与 → none」）。

### B2 默认初始化（用户设计）

- **路由三态**：`GET/POST /commander/takeover` 新增 `phase: none|provisioning|ready`
  （`lib/init-flow.js` 的 `computePhase`；`hasCommander` 保留兼容）。
- **`POST {init:true, draft}`**：只在 `phase==='none'` 允许；`draft` 由 `clampDraft` 截断到 16KB、
  `planInit` 里 trim；`runInitFlow` 依次「启动指挥员 → 写挡位（默认 observe）→ 投递草稿给主会话」，
  启动失败回 `start-failed` 且不继续后续步骤。
- **turn 安全**：新增 `createInitDelivery` —— turn 未打开就排队、`turn/start` 补发，
  **绝不在 turn 外 append**（11/13 事故线）。
- **默认挡位**：`DEFAULT_TAKEOVER` 由 `partial` 改为 **`observe`（督察模式）**，同步注释、文案与断言。
- **客户端**：`none`=蓝色问号（点击初始化，读 composer 草稿）、`provisioning`=蓝色旋转圈（1s 轮询）、
  `ready`=原有皇冠菜单；草稿走 DOM（textarea → contenteditable），读不到降级为空草稿。
- 测试：新增 `test/init.mjs`（**12 项**）；`takeover` 断言随默认值更新；14 套全绿；
  `index.js` 3114 行（≤ 3116）；client 的 `TakeoverBadge` 拆出 `PhaseIcon`/`badgeTitle`/
  `startInitFlow`/`NoCommanderHint` 以守住单函数 120 行棘轮。
### 验证状态

- 2.9.47 已实机验证通过：`/commander start` 成功创建指挥员（session `d9e671f2…`，status=running）、
  `/commander team` 正确列出 5 个并列子agent 并标记指挥员、切挡位会发通知。
- 2.9.48 是这个小修，**与下一次改动一起重启即可**，不必单独重启。
## 2.9.47

一句话：**接管状态真正管住 goal —— 进强管控覆写转译、退到弱参与自动暂停，用户不再被夺权。**

### 修的是什么

用户报：把挡位从「全接管/部分接管」切到「不接管/无指挥」，goal 依然 active，宿主继续自动续跑 →
用户关了指挥，agent 还在自己跑（"用户被夺权"）。核实代码：`applyTakeoverChange` 全文只做
「写 override + 发通知 + 清 handoff」，**完全没有碰 goal**。

### 口径（强弱参与）

- **强参与** = `partial` / `full`：指挥员接管 goal。
- **弱参与** = `observe` / `off`：goal 归用户，指挥员不驱动。

### 行为

| 切到 | goal 动作 |
|---|---|
| partial / full 且有活跃 goal | `goal.edit`：objective 覆写成接管模板（`【接管：部分接管】/【接管：全接管】` + 原文 + 执行边界；full 追加"可代用户拍板"），原文记入 `goalOrigins` |
| partial / full 且**没有** goal | `goal.create`：用模板新建（0→1 合法） |
| partial / full 且 goal 已 paused | 只 `edit` 并标记 `needsResume` —— **模型无权 resume**，等用户点恢复（用户设计原文就是"需要用户重新驱动"） |
| observe / off 且有活跃 goal | 若被覆写过先还原原文，再 `goal.pause` |
| observe / off 且 goal 已 paused/complete、或没有 goal | 不动 |

补充：**弱参与下不再自动续跑**（`resumeAfterAbnormal` 前置判断），否则用户退到弱参与后，
goal 又会因异常恢复自己跑起来 —— 这是同一条"夺权"路径的延伸。

### 实现

- 新增 `lib/goal-link.js`（纯决策 + 执行工厂）：
  `isStrongParticipation` / `buildTakeoverObjective` / `isTakeoverObjective` /
  `stripTakeoverObjective` / `planGoalSync`（返回 `none|create|edit|pause|restore-and-pause`）/
  `createGoalSync({ctx, rootSessionIdOf})` 执行器。
- `applyTakeoverChange` 在写完接管状态后调用 `syncGoal(...)`：**先写状态、再动 goal；
  goal 失败只记 `goalError` 并 warn，不回滚接管状态、不返回 500**。
- 模板幂等：已覆写过的 objective 会被 `stripTakeoverObjective` 还原出原文再重建，重复切换不叠加。

### 测试

- 新增 `test/goal-link.mjs`（**11 项**）：强弱分类、模板幂等与 full 差异、create/edit/pause/
  restore-and-pause 四类决策、paused 只标记不 resume、无服务静默跳过、goal 抛错只回报。
- 全套 13 个测试套件全绿；`index.js` 3115 行（≤ 基线 3116）；style 6/6。

> ⚠️ 与 2.9.45 / 2.9.46 一起生效，**一次重启**即可：`/commander status` 应显示 **2.9.47**。

## 2.9.46

一句话：**让「并行子agent」与「指挥员」共存——指挥员能看见并行工作，全接管交接会等并行收口。**

### 为什么不是加门禁

并行是效率（多子agent），指挥员是决策/接管，两者目的不同。上一版讨论里曾想加「派生需先咨询」
的拦截，结论是**不该加**：那会把效率重新变回串行。真正的摩擦只在两个接缝上：

1. **可见性**：指挥员看不到 Lead 派出去的子agent在干什么（它只能看到"有人存在"）。
2. **交接时机**：`shouldHandoff` 只看 `inFlight/turnEnded/status/takeover`，**完全不看子树** ——
   full 接管下 Lead 一轮结束、子agent还在跑时会立刻交接，指挥员对着半成品下判断。

### 改动

- **新增 `commander(action="team")`**（斜杠 `/commander team`，别名 `团队`/`并行`）：
  直接返回根会话下的并列子agent（`name / status / depth / id`），指挥员自己那一行带标记。
  数据来自 `ctx.subagents.listDescendants`（桥里的 `liveSubagents`），不再靠猜。
- **full 接管交接等子树**：`shouldHandoff` 新增 `subtreeBusy` 判定；`handoff-driver` 每次交接前
  用 `subtreeBusyOf()` 查一次（只算 `kind==='child'` 且状态为 `running`/`provisioning`、且不是指挥员自己）。
  忙就跳过本次交接并记 `lastSkip=…subtreeBusy=true`，同时 1.5s 后再看一次 —— 避免没有新事件
  就永远不交接。探测失败一律当作"不忙"，绝不因为探测本身把交接卡死。
- **文案**：`renderTeam()`（`lib/messages.js`）+ 5 个 locale key（中英各一份）；
  `/commander` 用法行补上 `team`。

### 测试

- `test/handoff.mjs` +1（20 项）：`subtreeBusy:true` 时不交接、`false` 时照常。
- `test/team.mjs` +1（11 项）：`listLiveSubagents` 只取 `kind==='child'`、补 `status/depth`、无服务返回空。
- `test/offline.mjs` +3 断言：`commander(action="team")` 渲染标题、列出成员 id、标记指挥员。
- `test/actions.mjs` 10 项（README 表、usage2、verb/别名全部随注册表派生，已同步）。

### 顺带停用危险的旧修复器（同一版本内）

`scripts/repair-session.mjs` 默认**拒绝执行**（exit 2）并指路 `doc/research/repair-v4.mjs`：
它会打印「通过」却漏改 compaction span，是 11/13 二次损坏的直接原因。要复现旧行为做对照，
必须显式加 `--legacy-unsafe`。

- `test/session-integrity.mjs` 3 → **4**：新增「默认拒绝执行且不改动文件」的守卫；
  旧算法的对照用例改为显式传 `--legacy-unsafe`。
### 实测踩到的三个坑（都已修）

1. `actions.js` 的注册表补了 `team`，但 `help.usage2` 文案里没列 → `actions.mjs` 立刻红了（说明守卫有效）。
2. `createHandoffDriver` 与 `createTeamBridge` 都撞 `test/style.mjs` 的单函数 120 行上限 ——
   把 `subtreeBusyOf` / `listLiveSubagents` / `agentIsLive` 提到模块级，工厂只留装配。
3. `index.js:apply` 与超长行基线都会因为新分支超限 —— 渲染搬进 `messages.js`，`apply` 只留 4 行。

> ⚠️ 与 2.9.45 一起生效，**需要一次重启**：`/commander status` 应显示 **2.9.46**。

## 2.9.45

一句话：**适配 DSH 0.2.2：Agent Teams 不再给成员 API，指挥员改由「可续接子agent」承担。**

### 现象

重启后（DSH 从 0.2.2-rc.1 升到 **rc.3**）点皇冠启动指挥员仍然失败，`/commander status` 显示：

```
指挥员成员：（Agent Teams 不可用：dsh-commander: 当前 profile 没有 Agent Teams 服务；请启用 agent-team profile 后再用指挥员。）
```

而这句是**误导**：`agentTeams` 服务在，是 API 换了。

### 根因（读安装包源码确认）

解析 `app.asar` 内 `@deepseek-ai/dsh-agent-team@0.2.2-rc.3`：`spawnTeammate` / `listMembers` /
`sendMessage` / `membership` 出现次数 **全为 0**，只剩任务板（`createTask` / `listTasks` /
`isEnabled` / `setEnabled`）。官方迁移指南（`docs/upgrade-guide/v0.2.1-rc.2/agent-team-subagents/`）写明：

> `ctx.agentTeams` removes creation, messaging, interruption, roster, membership, and wait APIs.
> Replace `spawnTeammate` … with `ctx.subagents.startActivation`, `sendMessage`, `interrupt`.
> Replace `membership` with `rootOf`, and `listMembers` with `listDescendants`.

插件的旧守卫 `typeof team.spawnTeammate !== 'function'` 命中，于是抛了那句「没有 Agent Teams 服务」。
旧进程一直在跑升级前的代码，所以升级当天还能用；一重启就暴露。

### 修法：新增 `lib/team.js`（Agent Teams 桥）

保持插件内部的**同步**读法（`listMembers` / `membership`），把新 API 的异步语义挡在桥里：

| 旧调用 | 新实现 |
|---|---|
| `team.spawnTeammate(agent, req)` | `ctx.subagents.startActivation({ provider, label, name, prompt, parent, signal, delivery:'parent' })` |
| `team.listMembers(agent)` | 按根会话缓存的同步视图；`refresh()` 用 `ctx.subagents.listDescendants` 更新 |
| `team.sendMessage(agent, req)` | 名字/id → session id，再 `ctx.subagents.sendMessage(agent, id, content, { signal })` |
| `team.membership(agent)` | 缓存反查（跨 bucket） |

配套改动：

- `index.js` 的 `teamService()` 改为返回桥；删掉 `ctx.get('agentTeams')` 的六处直接引用。
- 三处异步路径先 `refresh()` 再判定：插件重载时的根会话归因、`ensureCommanderTeammate`（避免已有指挥员却重复创建）、`status`。
- 成员身份改为**建完直接记账**（`commanderIds.add`）+ 记录 `agent/created` 交出的真实 agent：
  0.2.2 下 `agents.get(id)` 拿到的对象可能没有 `ctx.tools`，靠它取工具面会得到空集合，
  工具收紧会静默失效（本版实测踩到，测试里暴露为「read 被拒绝」）。
- `doctor` 先刷新再显示成员，避免把「已有指挥员」显示成「尚未创建」。
- 报错文案改为可操作：没有 subagents 服务时提示检查 base/subagent 能力，而不是误导成「没装 profile」。

### 测试

- 新增 `test/team.mjs`（**10 项**）：没有服务时的可读错误、`startActivation` 参数映射（含
  `signal instanceof AbortSignal`、`delivery:'parent'`）、列举过滤（只收同名 child、丢 diagnostic、
  清幽灵行）、`status` 实时取值、跨 bucket 的 membership、按名/id 解析发送、找不到成员时报出现有名字、
  `rootOf` 抛错时回退 header。
- `test/offline.mjs` 的宿主假实现整体迁到新 API（`subagents.startActivation/listDescendants/sendMessage`），
  断言面保持不变（`spawnCalls[0].request.name/description/prompt` 等 1052 行全部沿用）。
- `index.js` 3107 → **3111** 行（≤ style 基线 3116，未上调）；`lib/team.js` 211 行、单函数 ≤120、
  无超长行（`test/style.mjs` 6/6）。

> ⚠️ **仍需重启验证**：`/commander status` 应显示 **2.9.45**；点皇冠选「部分接管」应返回 200 并出现指挥员卡片。
> 若仍失败，请抓 `POST /commander/takeover` 的 `message` 原文与带 `dsh-commander:` 的服务端日志。

## 2.9.44

一句话：**修「点皇冠图标启动指挥员必定 500」——图标那条路径把 `undefined` 当 AbortSignal 传给宿主。**

### 现象（2026-11-14 实机复现）

用户在**新会话**（无指挥员）里点皇冠图标选挡位，什么都不会发生：

```
POST /commander/takeover  {"sessionId":"session-8f2af136…","state":"partial"}
→ HTTP 500
{"error":"start failed","message":"signals[0] is not of type AbortSignal."}
```

因为 500 发生在 `applyTakeoverChange()` **之前**，挡位状态根本没写入，连 `[接管状态]`
通知都不会发 —— 用户看到的就是「切挡位完全没反应」。

### 根因

`startCommanderFromUi()` 里把 signal 写死 `undefined`：

```js
return ensureCommanderTeammate(agent, cwd, docs, goal, undefined)
```

而 `ensureCommanderTeammate` 原样透传给宿主 `team.sendMessage` / `team.spawnTeammate`。
宿主的 Agent Teams 服务对每个入口都校验 `signals[0] instanceof AbortSignal`，`undefined`
直接抛错。`commander(action=start)` 有 `exec.signal` 所以能成 —— 这就是「工具能起、图标点不动」。
（2.9.43 修过同一类错误，但只修了交接与探针，图标路径是后加的，漏了。）

### 修法

- `lib/guards.js` 新增纯函数 `ensureAbortSignal(signal)`：传值原样返回（同一对象，
  调用方 `abort()` 仍生效）；只有 `undefined`/`null` 才现造一个**永不过期**的 signal
  —— UI 触发的启动本来就不该被谁中断；两次调用各造各的，不共享。
- `ensureCommanderTeammate` 开头 `const abortSignal = ensureAbortSignal(signal)`，
  `spawnTeammate` 与「已有指挥员时的契约同步 `sendMessage`」两条路径都改用它。
  防御放在被调用方，未来任何没有 signal 的调用方都不会再踩。

### 第三处同类漏网（放行前审出来的）

`sendToCommander` 仍把裸 `signal` 传进宿主（三条路径：`listCommanderChildren`、
`ctx.subagents.sendMessage` 旧卡片续接、`team.sendMessage`），来源是斜杠路径的
`invocation.signal` 与工具路径的 `exec.signal`。之前只有一处兜底，等于「防御只盖了
图标这条路」。2.9.44 一并归一：

- `sendToCommander` 开头 `const abortSignal = ensureAbortSignal(signal)`，三处统一用它；
- 静态门禁从「只扫 `ensureCommanderTeammate` 一块」升级为**全文件**：扫
  `team.sendMessage` / `team.spawnTeammate` / `ctx.subagents.sendMessage` 的所有调用点，
  signal 实参必须是 `signal: abortSignal`，出现裸 `signal`（`signal,` / `signal }` /
  `, signal)`）即判 FAIL；
- 另配**反例夹具**（把任一处改回裸 `signal`）断言门禁必须报错 —— 防止门禁自己变成假绿。

> 已知限制（B 批顺手改）：`ensureAbortSignal` 现在是 `signal ?? new AbortController().signal`，
> 名字叫「保证」但不校验传入值类型；应改成 `signal instanceof AbortSignal ? signal : …`。

### 顺带修的第二个 bug（同一路径上的下一次误判）
`commanderExists()` 的 `catch` 分支原先是全局 `commanderStarted.size > 0`：只要**任何**
会话起过指挥员，别的会话就会被误判成「已有指挥员」→ 跳过启动 → **又一次**「点挡位没反应」。

- `lib/takeover.js` 新增 `commanderMemberOf(members, name)` 与 `startedInSession(started, leadId)`；
- 兜底改为按**当前根会话**判断（`rootSessionIdOf(agent)`）；
- 三处写集合的地方（`agent/created`、`ensureCommanderTeammate` ×2）统一用根会话 id，
  原先混用 `agent.session.header.id`、`agent.id`、`root.id`，子会话/被接管会话下会 false negative。

### 测试

- `test/guards.mjs` 15 → **19**：`ensureAbortSignal` 三条（instanceof / 对象同一性 /
  两次不共享）+ 一条**静态门禁**（`ensureCommanderTeammate` 内不得出现裸 `signal,` 透传）。
- `test/takeover.mjs` 12 → **16**：兜底按会话判定（别的会话启动过 ≠ 本会话有指挥员，
  测试里把旧实现原样写成 `legacy` 断言它为 true，即「红的那一侧」）、根/子会话两分支、
  缺 id/缺集合/空集合一律 false、`commanderMemberOf` 只认 `role==='teammate'`。
- `test/style.mjs`：`index.js` 3115 → **3103**（只删空行连片，零行为变化），基线 3116 未上调。

> ⚠️ **待重启实机验证**：插件是宿主**进程内**加载，改文件对运行中的进程无效。
> 重启后判据：`/commander status` 显示 **2.9.44**（显示 2.9.43 就是进程还是旧的）；
> 在无指挥员的新会话点皇冠选挡位 → HTTP 200、`hasCommander:true`、指挥员卡片出现。

## 2.9.43

一句话：**修 2.9.42 修复工具自身的坑——重建出来的帧参数必须和宿主一致，否则宿主照样读不回来。**

2.9.42 的 `scripts/repair-session.mjs` 用 Node 默认的 `zstdCompressSync` 重压帧，写出的是
`single_segment=1, checksum=0`（descriptor `0x20`）；而 DSH 自己写的是
`single_segment=0, checksum=1`（descriptor `0x04`，XXH64 校验）。**参数不一致 → 宿主拒绝读取 →
会话在界面上直接消失**，表现就是"修完还是加载不起来"。

修法：`compressFrame()` 显式传 `ZSTD_c_checksumFlag=1` + `ZSTD_c_contentSizeFlag=0`，
帧头与宿主逐字节同型（实测 descriptor 一致、帧数一致）。

`test/session-integrity.mjs` 增加 3 项断言：修复后的首帧 descriptor 必须是 `0x04`、
必须带校验和、不允许 single-segment。这条正是 2.9.42 漏掉的——只测了"多帧"，没测"帧的参数"。

## 2.9.42

一句话：**修「一条接管通知写坏整条会话」的事故，并把修复工具化 + 加回归测试。**

### 1. 事故复盘（2026-11-13，会话 `session-4782adb7`）

GUI 报：

```
stored session "session-4782adb7-…" is corrupt:
SessionFormatError: developer/message does not match an open turn and step
```

定位到**一条事件**：

```
seq 17547  developer/message   ← 紧跟 seq 17546 turn/end
            id: commander-takeover-1794541993109   ← 没有随机后缀
            内容：「[接管状态] 用户已把接管状态切为『不接管』…」
```

结论：

- 这条是 **2.9.20 的旧写法**产生的（`append('developer/message')`，id 形如 `commander-takeover-${Date.now()}`）。2.9.21 已改成 `user/message` + `source.kind='runtime-context'`，当前 `index.js` 里已无该写法。id 缺随机后缀这一点是**版本指纹**：当前写法是 `commander-takeover-${Date.now()}-${random}`。
- 所以这不是"修过的 bug 又复发"，而是**旧进程残留**：宿主长时间没重启，2.9.20 的模块一直在跑，直到 11-13 才在"切接管状态恰好撞上轮次结束"时写出这条。
- 危害是**P0**：restore 校验对 `developer/message` 要求必须处在打开的 turn/step 内，**一条违规即判整份日志 corrupt**，24,356 条正常事件一起打不开，只能手工修日志。

### 2. 新增 `scripts/repair-session.mjs`（可复用的日志修复器）

```sh
node scripts/repair-session.mjs <session.v4.jsonl.zstd>                    # 只体检
node scripts/repair-session.mjs <session.v4.jsonl.zstd> --drop-seq=17547 --apply
```

- 按 zstd 帧边界切分 → 逐帧解码 → 丢弃越界事件 → 其后 `seq` 整体 −1（含 `headerSeq` / `sourceEventSeqs` / `surfaceOp.startSeq|endSeq` 引用）→ 重放校验 → 按原帧行数逐帧重压 → 写回（先备份 `.bak-<时间戳>`）。
- ⚠️ **必须保留多帧结构**：实测把 13,976 帧重压成 1 帧后，宿主读不回来（会话在界面上直接消失）。这是修日志最容易踩的坑，工具已按帧重建。

### 3. 新增 `test/session-integrity.mjs`（3 项守卫）

- 源码里**不允许**再出现 `append('developer/message')`；
- 接管通知必须是 `runtime-context` 的 `user/message`；
- 修复工具行为：只丢目标事件、`seq` 连续、**保持多帧**、其余事件内容不变。

### 4. 运维提醒

升级本插件后**重启 DSH**：`/commander doctor` 的「运行中 / 磁盘」两行不一致，就说明进程里还是旧代码——这次事故的直接诱因就是这个。

## 2.9.41

三件事：**给用户看的 README 重写**、**指挥员提示词改渐进式披露**、**根目录整理（模块进 `lib/`）**。

### 1. README 变成「用户决策文档」

开头四节换成用户真正要判断的东西：它解决什么问题（自循环迭代开发 / 把强模型判断力借给弱模型）、什么时候值得用、**模型怎么选**、三种模式的基础思路。

模型这条写死成建议：**不要用同类/同源模型当指挥员**——它默认会挑"自己那种"，两个同水平模型互相点头，token 烧完质量不涨。至少满足其一：比主agent 强一个量级，或来自不同厂商/不同训练路线（视野互补）。代价也写清楚了：**它放大你表达的清晰度**，需求含糊时会用更多轮次把含糊放大成返工。

### 2. 指挥员提示词：渐进式披露

指挥员按建议是贵模型，而贵模型每轮输入都计费、限制还更多。原来把决策协议、批次节奏、goal 审批、汇报审查、权限细则全塞常驻 prompt（**4334 字符 ≈ 3124 token**），每轮重付。

现在拆两层：

- **常驻**（`lib/prompts.js` 的 `buildCommanderPrompt()`）：身份、权限边界、输出契约（决定行 / REQ / CODE_STATE）、硬门禁、doc 路径 —— **1629 字符 ≈ 1051 token**（不含 doc 快照正文）；
- **按需**（新增 `COMMANDER-GUIDE.md`，2462 字符 ≈ 1588 token）：决策协议细则、批次节奏、goal 审批、完善性职责、汇报审查、权限优先级、侦察要求。

常驻层只留一句"细则在这个文件，需要时读"，所以**不读也能正确工作**。净效果：常驻上下文降约 62%，协议细则一条没删；`test/manual.mjs` 新增守卫盯住这条边界（guide 必须存在、必须随包发布、常驻 prompt 必须 <2600 字符）。

### 3. 说明书新增 `models` 分段（第 10 段）

`lib/manual.js` 加 `models`：明确告诉 agent「别挑自己那种模型」、至少拉一个量级或换训练路线、只有一个模型时要明说并交给用户决定。**这条必须给 agent 看**，否则它默认挑与主agent 同源的模型。工具说明仍只留「是什么 + 动作 + 硬门禁 + 指路」（635 字符）。

### 4. 根目录整理

根目录原来平铺 16 个 `.js` 模块。现在只留入口与文档：

```text
index.js            入口（组合层 + 工具层 + 斜杠命令层）
lib/                15 个实现模块
COMMANDER-GUIDE.md  细则手册（披露第二层）
test/ scripts/      守卫与脚本
```

- `index.js` 的 import 改为 `./lib/*.js`；`lib/` 内部互相 import 仍是 `./x.js`，**模块间依赖一行未改**；
- `package.json` 的 `exports`（`./client`、`./transcript-window`）同步指向 `lib/`，`files` 跟着改；
- `test/style.mjs` 改为扫 `index.js` + `lib/*.js`，基线仍按文件名登记；依赖方向检查同时识别 `./x.js` 与 `./lib/x.js`。

### 5. 顺带

- `prompts.js` 不再 import `COMMANDER_CONTRACT`（契约文本并进常驻 prompt 的一行），超长行基线 3 → 1；
- `manual.js` 超长行基线 21 → 20（`models` 段按句子断行）；
- `index.js` 3119 → 3116 行，基线同步下调到 3116。

十套测试全绿（offline / takeover / handoff / regressions / state-store / transcript-window / manual / style / actions / guards）。

## 2.9.40

守卫可测性（2.9.39 之后的一小步）。**行为零变化**，只把「该不该拦」的判定从宿主钩子里抽成纯函数。

为什么只抽判定、不搬钩子：守卫挂在 `tools.guard` / `tools.restrict` 上，搬注册顺序或作用域会让门禁**静默失效**（不报错、只是不拦），比崩溃更危险。而判定依赖的只是几个显式输入（接管状态、批准集合、工具名、命令文本），抽出来就能穷举测试——这正是 `offline.mjs` 一直在替它做的事。

- **新增 `guards.js`**（118 行，纯函数，无 import）：
  - `invalidatesApproval()` —— 写类工具或会改文件的 shell 命令让放行失效；
  - `askUserDenial()` —— 全接管下必须先咨询指挥员；
  - `goalGate()` —— complete 要放行、resume 交用户、edit/pause/blocked 要一次性批准、已在目标态幂等放行；
  - `toolSurfaceDenial()` —— 只读工具集 + 写作用域 + 只读 shell 的组合判决。
- **钩子只改调用**：`ctx.tools.guard` 两处、`goalGateError` 一处，注册顺序/作用域/钩子名一行未动（`git diff` 可核）。
- **新增 `test/guards.mjs`（15 项真值表）**：每道门禁「该拦 2 条 + 不该拦 2 条」，另加 goal 批准用一次后第二次被拒、已处于目标态放行、没有 phase 时的文案分支、写作用域/只读 shell 判决透传。
- `index.js` **净变化 0 行**（3119 → 3119）：判定搬走后又把转发层压缩回原行数；`test/style.mjs` 基线保持 3119 不变——这批次本来就不是为行数。

十套测试全绿；`commander(action="checks")` 现在有 10 项。

## 2.9.39

代码整理第二批（P2）：把「加一个 action 要改六处」收敛成「改一处」，并让斜杠命令复用工具实现。

- **新增 `actions.js`（action 注册表，唯一事实源）**：每个 action 一行（id / 中文摘要 / 英文摘要 / 是否斜杠可见 / 中文别名）。从它派生：
  - `COMMANDER_OUTPUT_SCHEMA` 的 `enum`（现在是 `enum: ACTION_IDS`，不再手写数组）；
  - `execute()` 的白名单与「未知 action」提示（不再手写第二个数组）；
  - 工具 description 里的 action 段（`actionSegment('en')`，中英各一份）；
  - 斜杠 verb 与中文别名解析（`resolveSlash()`）。
- **斜杠命令复用工具实现**：`/commander start|list|status` 改为直接调 `commanderTool.execute(...)`。**唯一的行为变化**是斜杠 `start` 补齐了工具路径的信息（模型/标题/接管状态/文档等 4 项），消除了两条路径的漂移。
- **新增 `test/actions.mjs`（8 项）**：断言 schema enum 直接引用 `ACTION_IDS`、description 由 `actionSegment` 派生、README 工具表每个 action 都有一行、`help.usage2` 列出全部 slash action、verb/别名解析与注册表一致、委派块确实调用同一实现、`index.js` 里不再有手写 action 数组。**这个测试第一次跑就抓到一个真漏**：README 工具表缺 `goal` 那一行（一直没有），已补。
- **`test/style.mjs`**：`index.js` 基线 3136 → **3119**；空 catch 检查扩展到**多行空体**（只注释的 catch 允许，因为那就是 best-effort 说明）；顺手把 7 处光秃秃的 `// 忽略` 换成具体原因。

`index.js` 3136 → 3119（-17）。**未达标项如实记录**：计划目标 ≤2400 没做到——本轮只合并了斜杠层，`execute()` 的 if 链本身是**唯一实现**（不是重复），把它改写成表属于纯形式重构、对 `index.js` 体积影响小而对交接路径风险大；我尝试过用脚本做整体改写，因为字符串/模板里的花括号导致配对错位、生成代码语法错误，**已回退**，没有硬推。真正的体积大头是 `apply()` 组合层（2475 行），要降它得拆守卫与工具注册，那是第三批。
## 2.9.38

代码整理第一批（P1 拆模块 + P3 卫生）。零行为变化，八个套件全绿。

**P1：从 `index.js` 搬出四个模块**（逻辑逐行未改，只把依赖改成工厂注入）

| 新模块 | 行数 | 内容 |
| --- | --- | --- |
| `prompts.js` | 131 | doc 骨架、goal 提醒、`buildCommanderPrompt`、`nowText` |
| `checks.js` | 183 | `checkCatalog` / `spawnCheck` / `runChecks` + 超时杀进程树 + 尾部截断 |
| `doctor.js` | 271 | `doctorReport` / `profileMounts` / `packageVersionAt` |
| `handoff-driver.js` | 313 | `driveHandoff` / `waitCommanderGuarded` / `requestHandoffDrive` / `wakeWithInstruction` / `summarizeTools` / `lastTurnStartSeq` / `lastAssistantText` |

`index.js` **3810 → 3136 行**（-674）。三处必要的实质改动，其余全是搬移：
- `doctor.js` 里的 `PLUGIN_DIR` 不能再用 `import.meta.url` 推导（在 doctor.js 里那会指向它自己），改由调用方传入；
- `doctor.js` 里 `ctx.get('goals')` 改为注入的 `getGoal(agent)`；
- 四个工厂的依赖表显式列出（`createChecks` / `createDoctor` / `createHandoffDriver`），函数签名就是耦合清单。

**P3：新增 `test/style.mjs` 当 lint（零依赖）**，6 项检查：
- 单文件 ≤900 行、单函数 ≤120 行；历史遗留进 `BASELINE`，**只降不升、不许新增条目**，函数改名后基线条目必须同步清理；
- 禁止真正空的 `catch {}`（实测现有代码**没有**空 catch——之前审计说的「74 处空 catch」是误读，那 74 处都有处理体，本轮修正了这条结论）；
- 单行 ≤140 字符（文本资产有基线）；
- 模块不得反向 import `index.js`，不得有循环依赖。

**新增 `ARCHITECTURE.md`**（91 行）：模块图、依赖方向、各模块职责与行数、为什么这样切、
还留在 `index.js` 里的东西与 P2 计划、规范与测试地图。

**未达标项（如实记录）**：计划里写的是 `index.js ≤2700`，实际 **3136**。差的 400 多行是工具入口
`execute()`(322) 与斜杠命令 `handleCommanderCommand`(133) 及其渲染——它们必须一起改成 action 表
才有意义，属于 P2；半步搬一次等于白搬。
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
