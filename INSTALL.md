# 安装（另一个 DSH 环境）

本插件是 **DSH bundle**（Host 插件 + 一个默认启用的伴生窗口插件），不需要编译，也没有 npm 运行时依赖。

## 方式一：从 GitHub 克隆（推荐）

```sh
git clone https://github.com/leleou209/dsh-commander.git
```

然后在目标 DSH 的会话里执行（路径换成你的克隆位置）：

```text
plugin_manager install_bundle target: "<克隆路径>/dsh-commander"
```

确认已启用：

```text
plugin_manager list_bundles
```

应能看到 `@local/dsh-commander`（版本与 `/commander status` 首行一致）、`enabled: true`，以及两行：`commander` 与 `commander-transcript-window`。

刷新页面，然后任选一种开始：

```text
/commander start                     # 创建指挥员
/commander 你帮我梳理这个仓库的架构    # 直接发需求
commander action=start               # 主agent调用
```

## 方式二：离线目录 / 压缩包

把 `dsh-commander/` 整个目录复制到目标机器任意位置（不要放进 DSH 安装目录），按上面同样的 `install_bundle` 步骤安装。

压缩包形态（`npm pack` 产物）只作为归档/传输用，见 Releases 页面：

```sh
tar -xzf local-dsh-commander-2.9.23.tgz
# 得到 package/，改名为 dsh-commander 后按目录方式安装
```

> `*.tgz` 不进 git 仓库；需要时从 GitHub Releases 下载。

## 依赖

- 目标环境已启用 Agent Teams（teammate 能力）；
- 主agent具备 `commander` / `commander_record` 工具；
- 无 npm 依赖；`schemastery` 从 DSH 安装目录动态加载。

## 安装后自检

在插件目录跑四套离线测试：

```sh
node test/offline.mjs
node test/regressions.mjs
node test/state-store.mjs
node test/transcript-window.mjs
```

预期依次是 `ALL CHECKS PASSED` / `REGRESSION CHECKS PASSED` / `STATE STORE CHECKS PASSED` / `TRANSCRIPT WINDOW CHECKS PASSED`。

在 DSH 里：

```text
/commander doctor
```

一条命令给出 PASS/WARN/FAIL：安装目录与 profile 是否一致、三处版本是否一致、状态文件权限与读写、问用户门禁、历史窗口、当前 `CODE_STATE`。

## 注意

- `commander-transcript-window` 默认启用，只压客户端历史请求的上限（默认 15 turn / 单页 34 条），不删日志、不改模型上下文；
- 状态文件在 `~/.dsh/commander/state.json`（目录 `0700`、文件 `0600`），可用配置 `statePath` 改；
- 旧 teammate 卡片描述不可改；新环境首次 `commander start` 显示「指挥员」；
- 改完插件源码后 HMR 不会重载 linked bundle：用 `plugin_manager set_bundle` 关掉再开，或重启 DSH，然后用 `/commander status` 首行确认版本。
