# dsh-commander

指挥员**核心**：建立并绑定一个常驻可续接的指挥员子agent，预热后待命；按接管挡位管住 goal 与「问用户」；全接管时自动交接。

这是从 `dsh-commander`（7,429 行运行时）抽出来的核心实现，**2,273 行**，行为口径一致。
不是重写功能，是**去掉历史堆积**：外围工具、适配器、可选表面全部不带。

## 它做什么

1. **建立并绑定**本会话的指挥员（`delivery: 'caller'`）；
2. 让它**预热**（读 `doc/{suggest,history,plan,agent}.md`）然后**待命**；
3. 按**接管挡位**管住 goal 与「问用户」，并收紧指挥员自己的工具面；
4. **全接管**时自动交接：本轮结束 → 汇报 → 等指令 → 唤醒新一轮。

初始化**不会**让主会话自动开工，**不会**建 goal，**不会**投递任何消息。

## 挡位

| 挡位 | 语义 |
| --- | --- |
| `off` | 指挥员休息：`say`/`wait` 拒绝，任何门禁都不生效 |
| `observe` | 在场当顾问，主agent 完全自由（**建立后的默认值**） |
| `partial` | goal 的 `complete` 要「允许结束」、`edit/pause/blocked` 要「批准：goal <动作>」 |
| `full` | 连「问用户」也收归指挥员，且每轮自动交接 |

挡位**跨进程保存**（按根会话），重启后恢复。放行/批准/已咨询是本轮语义，重启即清。

## 安装

```
# 先停用 @local/dsh-commander（两者默认工具名都是 commander，会冲突）
# 再把本目录加入 profile 的插件列表
```

客户端半有改动 → **刷新一次页面**。Host 半的 `PLUGIN_VERSION` 类常量不会热载，改版本需重启。

配置项（都有默认值）：`toolName` / `recordToolName` / `commanderName` / `routePath` /
`docDir` / `provider` / `statePath` / `enforceApproval` / `waitMs` / `pollMs` /
`initTimeoutMs` / `shellTools` / `writeScopes` / `allow`。

状态文件默认 `~/.dsh/commander/state.json`（与老包分开，可并存）。
路由默认 `/commander/takeover`。

## 相对老包去掉了什么

| 去掉 | 老包行数 | 为什么 |
| --- | --- | --- |
| `doctor` / `checks` / `coverage` / `client-probe` / `code-state` | ~807 | 校验工具自身的元机器，不是产品功能 |
| `messages`（i18n）/ `manual`（分主题说明书）/ `transcript-window` | ~812 | 可选表面；个人插件双语收益低 |
| `team.js` 同步成员桥 | 279 | **冷缓存就是「重启后图标不认指挥员」的根因** |
| `takeover-store` 反向持有 Map | 87 | 同步读路径自加的约束，只有 `tools.guard` 真需要 |
| `init-flow` 四态相位机 | 133 | 相位可由「在飞 / 失败 / 有指挥员」推导 |
| `state-store` 重型持久化 | 309 → 143 | 只留原子写 + 锁 + 损坏隔离 |
| 会话修复工具 + 完整性测试 | ~500 | 那是给一次写坏会话的事故善后 |

## 三处结构性改动（这是简化的核心）

**1. 成员不缓存。** `findCommander()` 每次按需 `await listDescendants`。
没有缓存就没有冷缓存，也就没有「重启后不认人」那一类 bug。

**2. 挡位一个缓存、两种访问器。** `store.mode(rootId)` 同步只给 `tools.guard`（宿主契约），
其余读路径全 async。不再需要 store 反向持有外部 Map、hydrate/ready 那套舞蹈。

**3. 相位由事实推导。** `inFlight` Map + 指挥员是否存在 → `none/provisioning/ready/failed`。
不维护第三套状态机。

## 保留的「配得上复杂度」的部分

- **`lib/driver.js`（271 行）**：交接受并发约束，九道守卫每条都对应真实踩过的坑
  （turn/end 触发、串行化、inFlight、基线防重发、看门狗、插话让位、并行收口、
  dispose 停运、**唤醒前重读挡位**）。
- **`lib/gate.js`（141 行）**：门禁真值表，纯函数穷举测试。
- **`lib/consult.js`（119 行）**：咨询握手，**工具与驱动共用同一套**，避免两边判定漂移。

## 体量对比

| | 老包 | 本包 |
| --- | --- | --- |
| 运行时总行数 | 7,429 | **2,275** |
| `index.js` | 3,115 | **294** |
| 最长函数 | `apply` **2,473** 行 | `apply` **215** 行 |
| 超 120 行的函数 | 多个（含 2473） | 3 个（215 / 170 / 145） |

## 测试

```
node test/modes.mjs         # 9   挡位真值表（weak→weak 零 goal 操作）
node test/gate.mjs          # 12  门禁：每道门该拦 2 条 + 不该拦 2 条
node test/handoff.mjs       # 9   交接九道守卫 + 协议解析
node test/store.mjs         # 8   落盘/恢复/损坏隔离/磁盘失败降级
node test/preheat.mjs       # 6   预热代价 + goal 决策
node test/goal-link.mjs     # 5   goal 联动执行（失败只回报不回滚）
node test/client-render.mjs # 10  React stub 真跑组件（TDZ / hooks 顺序 / 首帧）
node test/load.mjs          # 13  **假宿主真跑 apply()**：接线/路由/init/切挡位/门禁/cwd/清理
node test/invariants.mjs    # 13  架构不变量（防止简化被悄悄改回去）
```

**85 项全绿**，并且在 `npm pack` 出来的**打包件内**重跑一遍也全绿（证明没有漏文件、路径没错）。

`test/invariants.mjs` 是静态断言，钉住这次简化的关键决定：
`delivery` 必须是 caller、初始化不得动 goal、成员不得缓存、唤醒前必须重读挡位、
子会话判定必须在首帧、解析到指挥员必须立刻收紧工具面、路由必须等 `webServer` 就位、
cwd 必须优先取会话自带的、`index.js` 只做装配。

`test/load.mjs` 用假宿主把 `apply()` 真跑一遍——单测证明得了纯函数，证明不了接线。
它已经抓到三个真问题（见下）。

## 测试抓到的真问题（都已修）

1. **重启后指挥员工具面没被收紧**（安全洞）：`commanderIds` 是内存态，重启即空；
   路由发现"已有指挥员"就直接跳过 `ensureCommander`，于是**白名单从未生效**。
   现在改为「解析到指挥员就登记并收紧」（`remember`），并有回归用例 +
   静态不变量双保险。
2. **测试污染**：假宿主的 `workingDirectory` 返回 `process.cwd()`，`ensureDocs`
   因此在包目录里建了 `doc/`。已把沙箱指向临时目录。
3. 打包漏文件：`lib/consult.js`、`lib/docs.js` 最初没进 `files[]`（装上会加载失败），
   被新写的 `check-files` 自检抓到——这正是我在评审里指出过的那类坑。

### 真机上抓到的两个（0.1.1 修）

这两个假宿主原本测不出来，因为**假宿主比真宿主宽松**：

4. **路由从未注册 → 图标全 404**：`lib/routes.js` 在 `apply` 里直接
   `ctx.get('webServer')`。加载顺序稍变就是 `undefined`，接着 `return`，
   此后再也不注册。真机表现：`/commander/takeover` 与随便写的路径**同样 404**，
   `state.json` 永远不产生——客户端连一次挡位都没写成功。
   现在改成 `ctx.inject(['webServer'], (webCtx) => webCtx.effect(...))`，
   并在假宿主里加了 `holdWebServer` + `provide()`，能真正复现"服务晚到"。
   （老包 `index.js:2992` 早就用注释警告过这件事，重写时又踩了一遍。）
5. **cwd 解析错 → doc 写到 profile 目录**：`resolveCwd` 写成
   `await workingDirectory.get(agent, signal)`，而宿主契约是 `get(session)`、
   **同步返回**。于是永远拿不到，退回 `process.cwd()`——Electron 里那是
   `~/.dsh/profiles/desktop`。真机表现：profile 下凭空多出 `doc/` 四件套，
   里面躺着的正是本该写进项目的 `commander_record` 记录。
   现在 `agent.session.cwd` 优先，服务调用只作兜底且传 `session`，
   退回进程目录时 `logger.warn` 告警。


## 为什么子agent"起来了却半天不说话"（实测账）

真机日志（`~/.dsh/sessions/<ws>/<id>/session.v4.jsonl.zstd`）解出来的时间线：

| 时刻 | 事件 | 说明 |
| --- | --- | --- |
| 0.00s | `subagent/descriptor` + `agent/inbox/spliced`（整份预热提示词）+ `turn/start` | **上下文注入是毫秒级** |
| 0.16s | `step/start` | 请求已发出 |
| **57.64s** | 首条 `assistant/message` | `inputTokens: 269237`、`cacheReadTokens` **缺省** → 冷预填充 |
| 57.66s | 4 个 `read` 结果（doc 四件套） | 文档其实都是空骨架 |
| 82.16s | 首条 `text`（26 字） | 第二轮 24.4s，`cacheRead: 269184` |

结论：慢的不是注入，是**子会话的第一次模型调用要冷预填充整份工具表**——这个 profile 同时挂了
rea / blender / unity 三个 MCP（一百多个工具，描述都很长）加几十个 skill，全在系统前缀里。
`isSeeded: false` 说明**没有继承父会话历史**，那 269k 全是"环境固定开销"。

三条对策（3.1.1）：

1. **provider 默认改 `fork`**：fork 复用父会话逐字节相同的前缀，命中 KV cache；失败自动退 `spawn`。
2. **预热代价落盘**：实测数字写进 `state.json`，重启后 tooltip 仍给得出"秒/步/工具/token"。
3. **tooltip 说清为什么慢**：读不到代价时也写明"首次要预填充整份工具表，通常 60–90 秒，之后走缓存"。

根治要减前缀（按 preset 裁剪工具面），这不在插件权限内——插件只能选 provider 和把代价讲明白。



- 只读 shell 白名单是 **best-effort 启发式**，不是沙箱。
- 指挥员异常崩溃靠看门狗发现（默认 20 分钟上限），不再有宿主的即时推送。
- 子会话的服务端 `canControl` 在「会话未打开且非已知指挥员」时 fail-open；
  第一道防线是客户端首帧判定。
- 未实现「切到全接管立刻补一次交接」：要等下一次 `turn/end`。
- 与老包**默认工具名冲突**（都是 `commander`），并存时请改 `toolName`。

