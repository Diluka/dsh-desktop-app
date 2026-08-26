# Windows / Linux / macOS GUI 验证

本文用于验证首版远程模式。无头 CI
负责格式、lint、类型、单测和打包；本页覆盖必须在真实桌面环境观察的窗口、CEF、OpenSSH 与 DSH Web
行为。

## 准备

1. 确认目标机器可执行 `ssh -V`。
2. 在 `~/.ssh/config`（Windows 为 `%USERPROFILE%\.ssh\config`）准备一个可通过密钥或 `ssh-agent`
   非交互登录的 Host 别名。
3. 在终端执行一次 `ssh <Host别名> true`，完成首次主机密钥确认并验证非交互认证。
4. 确认远端 DSH Web 已监听远端回环地址，记录实际端口；默认是 `3080`。
5. 从仓库执行 `deno task check`，再构建目标平台目录包。

> [!NOTE]
> 从 WSL 交叉构建 Windows 后，请把整个 `dist/windows/DSH-Desktop/` 目录复制到 Windows
> 本地磁盘再运行，避免把 WSL/UNC 路径问题误判为应用问题。

## Linux

```bash
deno task build:linux
./dist/linux/DSH-Desktop/DSH-Desktop
```

如需便携包：

```bash
deno task package:linux
chmod +x ./dist/linux/DSH-Desktop.AppImage
./dist/linux/DSH-Desktop.AppImage
```

实时查看日志：

```bash
tail -f "${XDG_STATE_HOME:-$HOME/.local/state}/dsh-desktop/logs/dsh-desktop-$(date +%F).jsonl"
```

## Windows

在 Windows 上直接构建，或在 WSL 交叉构建：

```powershell
# Windows Deno
deno task build:windows
```

```bash
# WSL / Linux Deno
deno task build:windows
```

复制完整目录后运行其中的 `DSH-Desktop.exe`。如需安装包，执行 `deno task package:windows` 并运行
`dist/windows/DSH-Desktop.msi`。

实时查看日志：

```powershell
$day = Get-Date -Format yyyy-MM-dd
Get-Content "$env:LOCALAPPDATA\dsh-desktop\logs\dsh-desktop-$day.jsonl" -Wait
```

## macOS

```bash
# Apple Silicon
deno task build:macos:aarch64
open ./dist/macos/aarch64/DSH-Desktop.app

# Intel
deno task build:macos:x86_64
open ./dist/macos/x86_64/DSH-Desktop.app
```

DMG 由 macOS 主机构建：

```bash
deno task package:macos:aarch64
deno task package:macos:x86_64
```

当前 DMG 使用 ad-hoc 签名，首次测试可能需要在 Finder 中右键选择“打开”。实时查看日志：

```bash
tail -f "$HOME/Library/Logs/dsh-desktop/dsh-desktop-$(date +%F).jsonl"
```

## 必测场景

### 1. 首次启动与配置持久化

1. 启动应用。
2. 确认出现“选择服务器”页面，左侧显示 `Chromium / CEF` 与 `OpenSSH LocalForward`。
3. 添加 SSH Host 别名，端口保留 `3080`，保存后关闭并重新打开应用。
4. 确认服务器仍在列表中，且页面没有本地端口或内部 URL 字段。

预期日志包含 `app.start`、`ssh.probe`、`profiles.saved`、`app.shutdown` 和 `app.stopped`。

### 2. 默认端口连接

1. 选择远端 DSH Web 监听 `3080` 的服务器。
2. 点击“连接”。
3. 确认出现连接覆盖层，随后同一桌面窗口加载完整 DSH Web。
4. 使用 DSH 的普通导航、流式输出和会话功能，确认 Chromium 渲染及 WebSocket/流式行为正常。
5. 关闭窗口，确认本地 `ssh` 子进程同时退出。

预期日志依次包含 `ssh.tunnel_starting`、`ssh.tunnel_ready`，关闭时包含 `ssh.tunnel_exited` 且
`stopRequested` 为 `true`。

### 3. 自定义远端端口

1. 把测试服务器 DSH Web 改到非 `3080` 端口，或使用另一台已配置实例。
2. 编辑服务器配置并填写实际端口。
3. 连接并确认加载的是该端口上的 DSH Web。

预期 `ssh.tunnel_starting.remotePort` 等于配置值。

### 4. `.ssh/config` 生效

至少验证一个不直接等于真实主机名的 Host 别名。条件允许时再验证以下任一配置：

- 非默认 SSH 端口
- `IdentityFile`
- `ProxyJump`
- `HostName` 与 Host 别名不同

应用无需重复填写这些字段即可连接，证明解析由系统 OpenSSH 完成。

### 5. 可恢复错误

分别尝试：

- 不存在的 SSH Host 别名
- 无法认证的测试 Host
- 正确 SSH Host + 错误 DSH Web 端口

预期应用停留或返回选择页，给出可操作的中文错误；日志包含 `ssh.stderr` 和
`ssh.connect_failed`，应用不崩溃、不残留长期运行的 `ssh` 子进程。

### 6. 断线返回

连接成功后，让测试 SSH 会话中断（例如停止测试 sshd、断开测试网络，或结束对应本地 `ssh` 进程）。

预期窗口返回服务器选择页并显示连接断开提示，日志中的 `ssh.tunnel_exited.stopRequested` 为 `false`。

### 7. OpenSSH 缺失提示

只在可安全构造的测试环境执行，例如没有安装 OpenSSH Client 的 Windows 测试用户或最小 Linux 虚拟机。

预期选择页显示对应平台的安装指引，连接按钮不可用，日志包含 `ssh.probe` 且 `available` 为 `false`。

### 8. 语言与系统 locale

1. 在三个平台分别启动桌面应用，确认全程只有一次 CEF 启动且不出现 locale 自重启空白窗口。
2. 在 DSH 设置中保存语言后重启桌面应用，确认偏好仍然生效。
3. 确认 `app.start.systemLocale` 是运行机器检测到的 locale；该字段只用于诊断，不控制 DSH 界面语言。
4. locale 检测失败时该字段缺席，应用仍应正常启动。

### 9. 打开日志目录

在服务器选择页点击“打开目录”，确认 Windows Explorer、macOS Finder 或 Linux
默认文件管理器打开当前日志目录。 成功时日志包含 `logs.directory_opened`。Linux 缺少 `xdg-open`
或系统命令失败时，页面必须弹窗提示且日志包含 `logs.directory_open_failed`。

### 10. Windows 隐藏 OpenSSH 窗口

在 Windows 上分别观察应用启动时的 `ssh -V` 探测和点击“连接”后的长连接过程。

预期全程不出现 `cmd.exe`/控制台闪窗；连接、错误提示、日志和关闭时的 SSH 清理行为保持不变。

### 11. Windows 应用图标

安装 MSI 后检查安装目录中的
`DSH-Desktop.exe`、开始菜单快捷方式、运行窗口和任务栏。预期均显示项目鱼形图标， 而不是 Windows
默认可执行文件图标；若任务栏保留旧缓存，先取消固定再重新固定后复查。

## 回报模板

请为每个平台提供：

```text
OS / 版本：
构建命令：
运行产物：目录包 / AppImage / MSI / DMG
通过场景：1, 2, ...
失败场景：
复现步骤：
可见错误：
日志文件：
```

日志优先提供失败会话对应 `sessionId` 的完整事件。外发前可脱敏 SSH Host、用户名和本地路径；保留
`event`、`time`、`msg`、错误类别、退出码和事件顺序。
