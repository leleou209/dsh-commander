# 安装与测试（另一个 DSH 环境）

## 目录安装（推荐）

1. 把整个 `dsh-commander` 目录复制到目标机器任意位置；
2. 在目标 DSH 的会话里执行：

```text
plugin_manager install_bundle target: "<绝对路径>/dsh-commander"
```

3. 安装后确认 bundle 已启用：

```text
plugin_manager list_bundles
plugin_manager set_bundle target: "@local/dsh-commander" enabled: true
```

4. 刷新页面，然后在会话里：

```text
/commander start
```

或让主agent调用：

```text
commander action=start
```

## 交付物

本版本随包提供两种形态：

| 形态 | 路径 | 用法 |
| --- | --- | --- |
| 目录（推荐） | `dsh-commander-2.9.10/` | 直接作为 `install_bundle` 的 `target` 绝对路径 |
| 压缩包 | `local-dsh-commander-2.9.10.tgz` | 归档/传输；解压后得到 `package/`，按目录方式安装 |

tgz 由 `npm pack` 生成，文件名取自包名 `local-dsh-commander`，不要把它当目录路径传给 `install_bundle`，除非目标 DSH 版本明确支持 npm 文件 spec。解压示例：

```sh
tar -xzf local-dsh-commander-2.9.10.tgz
# 得到 package/，把 package 改名为 dsh-commander-2.9.10 后按上面的目录安装
```

## 依赖

- 已启用 Agent Teams（teammate 能力）；
- 主agent具备 `commander` / `commander_record` 工具；
- 无需 npm 依赖；schemastery 从 DSH 安装目录动态加载。

## 验证

在插件目录执行：

```sh
node test/offline.mjs
node test/transcript-window.mjs
```

预期：`ALL CHECKS PASSED` / `TRANSCRIPT WINDOW CHECKS PASSED`。

## 注意

- `commander-transcript-window` 默认 `enabled: false`：Host 侧包装未影响客户端初始历史流，待 Client 版。
- 旧 teammate 卡片描述不可改；新环境首次 `commander start` 会显示「指挥员」描述。
- 当前 bundle 为 Host-only；UI 窗口插件尚未完成。
