# 架构与依赖方向（2.9.38）

面向维护者：这个插件由哪些模块组成、谁依赖谁、哪些东西**故意**还没拆。

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
   prompts.js  checks.js doctor.js handoff-driver.js  manual.js  messages.js
        │          │       │        │                 │          │
        └──────────┴───────┴────────┴─────────────────┘          │
                              ▼                                   │
                        protocol.js  code-state.js  state-store.js  takeover.js  handoff.js
                              （纯函数 / 无宿主依赖）              │
                    client.js（浏览器侧 UI）  transcript-window.js（可选窗口）
```

依赖方向**单向**：`index.js` → 各功能模块 → 纯函数模块。没有任何模块 import `index.js`，
也没有循环依赖（`test/style.mjs` 强制）。

## 各模块职责

| 模块 | 行数 | 职责 | 依赖 |
| --- | --- | --- | --- |
| `index.js` | ~3135 | 组装：配置、持久化、接管状态、pending、守卫、工具注册、斜杠命令、HTTP 路由 | 全部 |
| `prompts.js` | 131 | doc 骨架、goal 提醒、指挥员初始 prompt | protocol |
| `checks.js` | 183 | 受控检查：解析 `checkCommands`、跑命令、超时杀进程树、尾部截断 | node:child_process |
| `doctor.js` | 271 | 自检：安装/版本/挂载、成员、持久化、门禁、窗口、环境 | state-store, code-state |
| `handoff-driver.js` | 313 | 全接管交接：判定、取本轮输出与工具摘要、等回复、注入指令 | handoff |
| `manual.js` | 245 | 主agent 说明书（9 段）+ 工具说明 | 无 |
| `messages.js` | 368 | 用户可见文案 zh/en 目录 + `t()` | 无 |
| `takeover.js` | 84 | 接管四态语义、门禁判定 | 无 |
| `handoff.js` | 120 | 交接纯逻辑：判定、分类、渲染、等回复后的决策 | messages |
| `protocol.js` | 160 | 决议协议解析、契约常量、CODE_STATE 格式 | 无 |
| `code-state.js` | 161 | 代码状态快照（git HEAD + 文件哈希） | node:fs |
| `state-store.js` | 309 | 状态文件：原子写、权限、跨进程锁、迁移、修剪 | node:fs |
| `client.js` | 305 | composer 图标 + 状态菜单（浏览器侧） | 无 |
| `transcript-window.js` | 141 | 可选的历史窗口挂载 | node:path |

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

P2 目标：把「工具路径 vs 斜杠命令路径」合并成一张 `ACTIONS` 表 + 一个 `dispatch()`，
让加一个 action 只改 2 处（表 + schema enum），`index.js` 降到 2000 行以内。

## 规范（由 `test/style.mjs` 强制）

- 单文件 ≤900 行、单函数 ≤120 行；历史遗留进 `BASELINE`，**只能降不能升，也不许新增条目**。
- 禁止真正空的 `catch {}`（必须处理错误或注明 best-effort）。
- 单行 ≤140 字符（文本资产如 `messages.js` / `manual.js` 有基线）。
- 模块不得反向 import `index.js`，不得有循环依赖。
- 文案进 `messages.js`；模型可见的说明书进 `manual.js`；两者的改动都要过对应测试。

## 测试地图

| 套件 | 覆盖 |
| --- | --- |
| `test/offline.mjs` | 整插件冒烟：守卫、pending、放行、goal 门禁、恢复 |
| `test/takeover.mjs` | 四态语义与门禁判定 |
| `test/handoff.mjs` | 交接判定/分类/渲染/等回复决策 |
| `test/regressions.mjs` | CODE_STATE、决议行、文案目录对齐 |
| `test/state-store.mjs` | 权限、锁、损坏隔离、迁移、修剪 |
| `test/manual.mjs` | 说明书 topic 完整、md 与源一致、令牌保留 |
| `test/style.mjs` | 体量、空 catch、超长行、依赖方向 |
| `test/transcript-window.mjs` | 历史窗口挂载/卸载 |
