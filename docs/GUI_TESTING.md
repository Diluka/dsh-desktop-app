# Windows / Linux / macOS GUI 验证

本文用于验证首版远程模式。无头 CI
负责格式、lint、类型、单测和打包；本页覆盖必须在真实桌面环境观察的窗口、CEF/WebView2、OpenSSH 与 DSH
Web 行为。

## 准备

1. 确认目标机器可执行 `ssh -V`。
2. 在 `~/.ssh/config`（Windows 为 `%USERPROFILE%\.ssh\config`）准备一个可通过密钥或 `ssh-agent`
   非交互登录的 Host 别名。
3. 在终端执行一次 `ssh <Host别名> true`，完成首次主机密钥确认并验证非交互认证。
4. 确认远端 DSH Web 已监听远端回环地址，记录实际端口；默认是 `3080`。
5. 从仓库执行 `deno task check`，再构建目标平台目录包。

> [!NOTE]
> 从 WSL 交叉构建 Windows 后，请把整个 `dist/windows/DSH-Desktop-CEF/` 或
> `dist/windows/DSH-Desktop-WebView/` 目录复制到 Windows 本地磁盘再运行，避免把 WSL/UNC
> 路径问题误判为应用问题。

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
log_dir="${XDG_STATE_HOME:-$HOME/.local/state}/dsh-desktop/logs"
tail -f "$(ls -t "$log_dir"/dsh-desktop-*.jsonl | head -n 1)"
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

分别复制完整的 `dist/windows/DSH-Desktop-CEF/` 与 `dist/windows/DSH-Desktop-WebView/` 目录，运行
其中同名 EXE。执行 `deno task package:windows` 会生成 `DSH-Desktop-windows-x86_64-cef.zip` 和
`DSH-Desktop-windows-x86_64-webview.zip`；完整解压后再运行， 不能只复制 EXE。Windows
两个版本都需覆盖本节场景；WebView2 版本还需确认系统 Runtime 可用。

实时查看日志：

```powershell
$log = Get-ChildItem "$env:LOCALAPPDATA\dsh-desktop\logs\dsh-desktop-*.jsonl" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
Get-Content $log.FullName -Wait
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

macOS 分发包在 Linux 交叉构建为完整 `.app` tar.gz：

```bash
deno task package:macos:aarch64
deno task package:macos:x86_64
```

解压对应的 `dist/macos/DSH-Desktop-macos-*.tar.gz` 后运行完整 `.app`。产物未进行 Apple Developer ID
签名或 notarization，首次测试可能需要在 Finder 中右键选择“打开”。实时查看日志：

```bash
log_dir="$HOME/Library/Logs/dsh-desktop"
tail -f "$(ls -t "$log_dir"/dsh-desktop-*.jsonl | head -n 1)"
```

## 必测场景

### 1. 首次启动与配置持久化

1. 启动应用，确认窗口保持原生默认尺寸，不发生可见的二次尺寸调整。
2. 确认出现“选择服务器”页面；CEF 版左侧显示 `Chromium / CEF`，WebView2 版显示
   `Microsoft Edge WebView2`，连接方式均显示 `OpenSSH`。
3. 添加 SSH Host 别名，端口保留 `3080`，保存后关闭并重新打开应用。
4. 确认服务器仍在列表中，且页面没有本地端口或内部 URL 字段。

预期日志包含 `app.start`、`ssh.probe`、`profiles.saved`、`app.shutdown` 和 `app.stopped`。

### 2. 默认端口连接

1. 选择远端 DSH Web 监听 `3080` 的服务器。
2. 点击“连接”。
3. 确认出现连接覆盖层，随后同一桌面窗口加载完整 DSH Web。
4. 使用 DSH 的普通导航、流式输出和会话功能，确认当前后端渲染及 WebSocket/流式行为正常。
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

预期应用停留或返回选择页，给出可操作的中文错误；JSONL 包含 `ssh.tunnel_failed`、
`ssh.connect_failed` 和 `childOutputFile`，对应 `.child.log` 保留 OpenSSH 原始输出。应用不崩溃、
不残留长期运行的 `ssh` 子进程，原始输出也不应出现在 JSONL 中。

### 6. 断线返回

连接成功后，让测试 SSH 会话中断（例如停止测试 sshd、断开测试网络，或结束对应本地 `ssh` 进程）。

预期窗口返回服务器选择页并显示连接断开提示，日志中的 `ssh.tunnel_exited.stopRequested` 为 `false`。

### 7. OpenSSH 缺失提示

只在可安全构造的测试环境执行，例如没有安装 OpenSSH Client 的 Windows 测试用户或最小 Linux 虚拟机。

预期选择页显示对应平台的安装指引，连接按钮不可用，日志包含 `ssh.probe` 且 `available` 为 `false`。

### 8. 语言与系统 locale

1. 在 Linux/macOS CEF 版与 Windows CEF/WebView2 两个版本分别启动，确认不出现 locale 自重启空白窗口。
2. 在 DSH 设置中保存语言后重启桌面应用，确认偏好仍然生效。
3. 确认 `app.start.systemLocale` 是运行机器检测到的 locale；该字段只用于诊断，不控制 DSH 界面语言。
4. locale 检测失败时该字段缺席，应用仍应正常启动。

### 9. 打开日志目录

在服务器选择页点击“打开目录”，确认 Windows Explorer、macOS Finder 或 Linux
默认文件管理器打开当前日志目录。 命令成功交给系统时日志包含 `logs.directory_open_requested`。Linux
缺少 `xdg-open` 或系统命令失败时，页面必须弹窗提示且日志包含 `logs.directory_open_failed`。

### 10. Windows 隐藏 OpenSSH 窗口

在 Windows 上分别观察应用启动时的 `ssh -V` 探测、点击“连接”后的长连接，以及点击本地启动后的 npx
fallback。

预期全程不出现可见的 `cmd.exe`/控制台闪窗；连接、错误提示、日志和关闭时的子进程清理行为保持不变。

### 11. Windows 和 macOS 应用图标

1. 解压两个 Windows ZIP 后分别检查各自目录内的 `DSH-Desktop.exe`、运行窗口和任务栏。
2. 在 Windows 浅色和深色模式下重复检查；若任务栏保留旧缓存，先取消固定再重新固定后复查。
3. 在对应架构的 macOS 上解压并打开 `.app`，在浅色和深色模式下检查 Finder 和 Dock 中的图标。

预期 Windows 与 macOS 均显示带细边框的黑色底、白色鱼形项目图标，而不是系统或浏览器默认图标；图标在
浅色和深色系统外观中均清晰可辨。关闭应用后用新分发包完整覆盖旧目录，确认应用可正常启动且服务器配置仍保留。

### 12. 本地模式、npx 回退与终止

1. 从 Finder 启动应用，确认窗口立即出现；打开“本地模式”，环境检测完成后显示平台、Node.js、DSH CLI 和
   npx 版本，条件不足时启动按钮禁用。
2. 检查应用启动阶段的进程与网络，确认只执行各工具自身的 `--version`，不会执行
   `npx -y @deepseek-ai/dsh --version` 或下载 DSH 包。
3. PATH 中存在 `dsh` 时点击“启动本地 DSH”，确认直接加载本地 DSH Web。
4. 在隔离测试环境中隐藏 `dsh`、保留可运行的 npx，再次点击“启动本地 DSH”。
5. 确认此时才开始 npx 下载；等待弹窗提示首次下载可能超过 30 分钟、不自动超时，并显示“终止启动”按钮。
6. 在 npx 仍运行时点击“终止启动”，确认弹窗关闭、页面提示已终止，且不残留 `npx`/DSH 子进程。
7. 再次启动并允许 npx 完成，确认同一窗口加载 DSH Web。
8. 同时隐藏 `dsh` 和 npx，确认启动按钮保持禁用并显示缺失环境。

预期 JSONL 包含 `local_dsh.npx_fallback`，成功或失败事件包含 `childOutputFile`。npx
原始下载输出不会复制到 JSONL，仅写入对应的 `.child.log`。

## 回报模板

请为每个平台提供：

```text
OS / 版本：
构建命令：
运行产物：目录包 / ZIP / tar.gz
通过场景：1, 2, ...
失败场景：
复现步骤：
可见错误：
JSONL 日志文件：
子进程 `.child.log`：
```

日志优先提供失败进程对应 JSONL 文件中的完整事件，并按 `childOutputFile` 附上对应的 `.child.log`。
子进程日志是未经脱敏的原始输出，外发前检查 SSH Host、用户名、本地路径和其他敏感内容；JSONL 保留
`event`、`time`、`msg`、错误类别、退出码和事件顺序。
