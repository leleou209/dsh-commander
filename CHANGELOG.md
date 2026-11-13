# 更新日志

版本号与 `package.json` / `index.js` 里的 `PLUGIN_VERSION` 一致；`/commander status` 首行显示运行中的版本。

## 2.9.20

- **切换接管状态会告诉主agent**：你在图标菜单里换状态，Host 会往会话里写一条 `developer/message`，内容是「[接管状态] 用户已把接管状态切为「部分接管」：goal 的 complete/edit/pause/blocked 需要先取得指挥员批准；问用户不受限。」之前切换是纯内存写入，主agent 完全不知道，只能等撞上门禁才发现。
- 这条消息的 `source` 是 `system-prompt` 而不是 `user`，所以不会触发「全接管自动降为部分接管」，也不会清零「已咨询指挥员」。
- 状态没变就不写（反复点同一个选项不刷屏）；`commander(action="start")` 落定状态时也写一条。
- 路由 POST 的返回里多了 `announced`，用来确认这条通知到底写没写进去。

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
