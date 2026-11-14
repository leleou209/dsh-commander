# 架构与依赖方向（2.9.41）

面向维护者：这个插件由哪些模块组成、谁依赖谁、哪些东西**故意**还没拆。

## 布局

```
index.js              入口：apply() 组合层 + 工具层 + 斜杠命令层（唯一碰宿主服务的地方）
lib/                  全部实现模块（15 个，纯逻辑与工厂）
COMMANDER-GUIDE.md    指挥员细则手册（渐进式披露第二层，按需读）
test/ scripts/        守卫套件与开发脚本
```

2.9.41 起根目录只留入口与文档：模块全部进 `lib/`，`index.js` 的 import 改成 `./lib/*.js`，
`package.json` 的 `exports`（`./client`、`./transcript-window`）同步指向 `lib/`。
`lib/` 内部互相 import 仍是 `./x.js`，所以搬迁没改一行模块间依赖。

## 一句话

一个 Host 插件（`index.js` 的 `apply()`）把「指挥员」装成一个长期在线的 Agent Teams teammate，
并用四个门禁（接管状态 / goal 批准 / 放行 / 问用户）约束主agent 与它的协作。
纯逻辑尽量放在独立模块里，`index.js` 只做组合、注册与守卫。

## 模块图

```
                    ┌──────────────┐
                    │  index.js    │  组合 + 注册 + 守卫（唯一有宿主服务的地方）
                    └──────┬───────┘
        ┌──────────┬───────┼────────┬───────────┬──────────────┐
        ▼          ▼       ▼        ▼           ▼              ▼
  prompts.js  checks.js doctor.js handoff-driver.js  manual.js  messages.js  actions.js
        │          │       │        │                 │          │
        └──────────┴───────┴────────┴─────────────────┘          │
                              ▼                                   │
                        protocol.js  code-state.js  state-store.js  takeover.js  handoff.js
                              （纯函数 / 无宿主依赖）              │
                    client.js（浏览器侧 UI）  transcript-window.js（可选窗口）
```

（上图文件名均位于 `lib/`，只有 `index.js` 在根目录。）

依赖方向**单向**：`index.js` → 各功能模块 → 纯函数模块。没有任何模块 import `index.js`，
也没有循环依赖（`test/style.mjs` 强制）。

## 各模块职责

| 模块 | 行数 | 职责 | 依赖 |
| --- | --- | --- | --- |
| `index.js` | ~3116 | 组装：配置、持久化、接管状态、pending、守卫、工具注册、斜杠命令、HTTP 路由 | 全部 |
| `lib/prompts.js` | 138 | doc 骨架、goal 提醒、指挥员**常驻 prompt**（渐进式披露第一层） | 无 |
| `lib/checks.js` | 183 | 受控检查：解析 `checkCommands`、跑命令、超时杀进程树、尾部截断 | node:child_process |
| `lib/doctor.js` | 271 | 自检：安装/版本/挂载、成员、持久化、门禁、窗口、环境 | state-store, code-state |
| `lib/handoff-driver.js` | 313 | 全接管交接：判定、取本轮输出与工具摘要、等回复、注入指令 | handoff |
| `lib/manual.js` | 276 | 主agent 说明书（10 段）+ 工具说明 | actions |
| `lib/actions.js` | 78 | **action 注册表**：id/双语摘要/别名/是否斜杠可见；派生 enum、description、斜杠解析 | 无 |
| `lib/guards.js` | 118 | **门禁判定**（纯函数）：放行失效、问用户、goal 变更、指挥员工具面 | 无 |
| `lib/messages.js` | 368 | 用户可见文案 zh/en 目录 + `t()` | 无 |
| `lib/takeover.js` | 84 | 接管四态语义、门禁判定 | 无 |
| `lib/handoff.js` | 120 | 交接纯逻辑：判定、分类、渲染、等回复后的决策 | messages |
| `lib/protocol.js` | 160 | 决议协议解析、契约常量、CODE_STATE 格式 | 无 |
| `lib/code-state.js` | 161 | 代码状态快照（git HEAD + 文件哈希） | node:fs |
| `lib/state-store.js` | 309 | 状态文件：原子写、权限、跨进程锁、迁移、修剪 | node:fs |
| `lib/client.js` | 305 | composer 图标 + 状态菜单（浏览器侧） | 无 |
| `lib/transcript-window.js` | 141 | 可选的历史窗口挂载 | node:path |

## 为什么这样切

- **纯逻辑必须可单测**：`takeover` / `handoff` / `manual` / `protocol` / `code-state` / `state-store`
  不碰宿主服务，`test/` 里能直接断言，不需要伪造整个 DSH。
- **宿主耦合集中在 index.js**：宿主服务（`tools` / `subagents` / `agentTeams` / `goals` /
  `webServer` / `sessions`）只能通过 `ctx.get(...)` 或 `ctx.inject(...)` 拿，
  把它们散到各模块会让"谁能碰宿主"变得不可审计。
- **工厂注入而非全局**：`createChecks` / `createDoctor` / `createHandoffDriver` 都显式接收依赖。
  函数签名就是耦合清单——想知道 doctor 依赖什么，看那 13 个字段就够了。

## 还留在 index.js 里的（P2 计划）

| 东西 | 行数 | 为什么还没拆 |
| --- | --- | --- |
| `apply()` 闭包 | 2475 | 它就是组合层；拆它等于拆插件生命周期，收益低于风险 |
| `execute()`（工具入口） | ~322 | 与斜杠命令 `handleCommanderCommand`（133 行）是**同一批功能的两个实现**，要一起拆成一张 action 表 |
| `commanderStatus` / `commanderRoster` / `start` 渲染 | ~230 | 与工具/命令双路径一起改才划算，否则白搬一次 |
| 守卫（`applyCommanderRestriction` / goal 门禁 / 问用户门禁） | ~150 | 依赖 `tools.restrict` 与宿主工具面，动它要单独验证 |

P2 已完成的部分（2.9.39）：斜杠 `start|list|status` 改为直接调 `commanderTool.execute`，
action 的元数据（enum / description / usage / 别名）全部从 `actions.js` 派生，
`test/actions.mjs` 保证加一个 action 只改 `actions.js` 一处。

2.9.40 又抽出了 `guards.js`（门禁判定纯函数 + 15 项真值表）：钩子只做转发，注册未动。

仍未做（第三批）：`execute()` 的 if 链本身是**唯一实现**，不是重复——把它改成表分派属于纯形式
重构，体积收益小、对交接路径风险大（本轮脚本改写因模板字符串里的花括号配对错位而失败，已回退）。
体积大头其实是 `apply()` 组合层（2475 行）：要显著下降得拆守卫与工具注册。

## 2.9.41：指挥员提示词的渐进式披露

指挥员按建议就是"贵模型"（见 README「模型怎么选」），而越贵的模型每轮输入越贵、限制也越多。
原来的做法是把决策协议、批次节奏、goal 审批、汇报审查、权限细则全塞进常驻 prompt（4334 字符 ≈ 3124 token），
每一轮都重付一次。

2.9.41 把它拆成两层：

| 层 | 位置 | 内容 | 体量 |
| --- | --- | --- | --- |
| 常驻 | `lib/prompts.js` 的 `buildCommanderPrompt()` | 身份、权限边界、输出契约（决定行/REQ/CODE_STATE）、硬门禁、doc 路径 | **1629 字符 ≈ 1051 token**（不含 doc 快照正文） |
| 按需 | `COMMANDER-GUIDE.md` | 决策协议细则、批次节奏、goal 审批、完善性职责、汇报审查、权限优先级、侦察要求 | 2462 字符 ≈ 1588 token，只在需要时读 |

常驻层保留一句"细则在 `COMMANDER-GUIDE.md`，需要时读"——**不读也能正确工作**，读了更细。
净效果：常驻上下文降约 62%，协议细则没有丢，只是不再每轮重付。
`test/manual.mjs` 盯住这条边界：guide 必须存在、必须进 `package.json` 的 `files`、常驻 prompt 必须 <2600 字符。

同时 `lib/manual.js` 增加 `models` 分段（第 10 段）：明确告诉 agent「别挑自己那种模型」，
否则它默认会挑与主agent 同源的模型。这条既是给用户看的（README），也是给 agent 看的（说明书）。

## 2.9.42：会话日志完整性与修复工具

消息类事件不能从异步回调里随手写。宿主对 `developer/message` 的 restore 校验要求它
**处在打开的 turn/step 内**，而写入时并不校验——写错位置不会当场报错，而是在下一次
恢复会话时让**整份日志**判死（P0 级，24,000+ 条正常事件一起打不开）。

因此：插件侧的通知一律走 `user/message` + `source.kind='runtime-context'`（2.9.21 起），
`test/session-integrity.mjs` 盯死「源码不许再出现 `append('developer/message')`」。
修复入口：`scripts/repair-session.mjs`（用法见 README「会话日志修复」）。

⚠️ 重建日志必须**保留多帧结构**：DSH 每帧一次 append，把多帧压成单帧后宿主读不回来
（实测 13,976 帧 → 1 帧，会话在界面上直接消失）。

## 规范（由 `test/style.mjs` 强制）

- 单文件 ≤900 行、单函数 ≤120 行；历史遗留进 `BASELINE`，**只能降不能升，也不许新增条目**。
- 禁止真正空的 `catch {}`（必须处理错误或注明 best-effort）。
- 单行 ≤140 字符（文本资产如 `lib/messages.js` / `lib/manual.js` 有基线）。
- 模块不得反向 import `index.js`，不得有循环依赖（`lib/` 内的 `./x.js` 与 `index.js` 的 `./lib/x.js` 都识别）。
- 文案进 `lib/messages.js`；模型可见的说明书进 `lib/manual.js`；两者的改动都要过对应测试。

## 测试地图

| 套件 | 覆盖 |
| --- | --- |
| `test/offline.mjs` | 整插件冒烟：守卫、pending、放行、goal 门禁、恢复 |
| `test/takeover.mjs` | 四态语义与门禁判定 |
| `test/handoff.mjs` | 交接判定/分类/渲染/等回复决策 |
| `test/regressions.mjs` | CODE_STATE、决议行、文案目录对齐 |
| `test/state-store.mjs` | 权限、锁、损坏隔离、迁移、修剪 |
| `test/manual.mjs` | 说明书 topic 完整、md 与源一致、令牌保留 |
| `test/style.mjs` | 体量、空 catch（含多行）、超长行、依赖方向 |
| `test/actions.mjs` | 注册表派生一致性（enum/description/README/usage/别名/委派） |
| `test/session-integrity.mjs` | 日志不写越界事件、接管通知走 runtime-context、修复工具保持多帧 |
| `test/guards.mjs` | 四道门禁真值表（该拦/不该拦、一次性批准、幂等） |
| `test/transcript-window.mjs` | 历史窗口挂载/卸载 |
