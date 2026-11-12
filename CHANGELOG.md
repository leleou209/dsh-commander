# 更新日志

版本号与 `package.json` / `index.js` 里的 `PLUGIN_VERSION` 一致；`/commander status` 首行显示运行中的版本。

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
