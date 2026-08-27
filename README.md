# DSH Desktop

[![CI](https://github.com/Diluka/dsh-desktop-app/actions/workflows/ci.yml/badge.svg)](https://github.com/Diluka/dsh-desktop-app/actions/workflows/ci.yml)

DSH 的 Windows、Linux 与 macOS 桌面入口。本地模式直接启动 PATH 中的 `dsh web`；远程模式调用本机
OpenSSH Client 建立本地端口转发，再打开远端 DSH Web。Windows 同时提供内置 Chromium（CEF）与系统
WebView2 两种版本；Linux 和 macOS 使用 CEF。

> [!IMPORTANT]
> `deno desktop` 从 Deno 2.9 开始提供，目前仍标记为 experimental。CEF 版本自带 Chromium、体积较大；
> WebView2 版本体积较小，但依赖 Windows 已安装的 Microsoft Edge WebView2 Runtime。

## 当前范围

- 本地模式在自动选择的回环端口启动 `dsh web`，并在桌面窗口中打开。
- 服务器配置保存 SSH Host/别名和远端 DSH Web 端口，端口默认 `3080`。
- OpenSSH 自动读取 `~/.ssh/config`，原生支持其中的用户、端口、密钥、`ProxyJump` 和其他选项。
- 本地转发只绑定 `127.0.0.1`，空闲端口由应用自动选择。
- SSH 成功后移除选择页的本地 bindings，再导航到 DSH Web。
- Pino JSONL 日志记录启动、配置、本地 DSH、OpenSSH、隧道和退出生命周期。
- CEF 与 WebView2 共用配置、SSH、日志和本地选择页；系统 locale 仅写入日志，界面语言使用 DSH
  已保存的偏好。
- 支持 Windows x86_64 的 CEF/WebView2，以及 Linux x86_64、macOS arm64 与 macOS x86_64 CEF 构建。

首版认证使用密钥或 `ssh-agent`，不在应用内接收或保存 SSH 密码、私钥内容和 passphrase。

## 前置条件

开发与构建需要：

- [Deno 2.9+](https://docs.deno.com/runtime/desktop/)
- Windows 10/11、现代 x86_64 Linux，或 Intel/Apple Silicon macOS
- 本地模式需要 PATH 中可用的 DSH CLI（`dsh --version`）
- 远程模式需要 PATH 中可用的 OpenSSH Client（`ssh -V`），且远端机器已启动 DSH Web

Windows 缺少 `ssh` 时，可在“设置 → 系统 → 可选功能”中安装 **OpenSSH 客户端**。Debian/Ubuntu 可执行：

```bash
sudo apt install openssh-client
```

建议先把连接信息放入 SSH 配置：

```sshconfig
Host my-dsh
  HostName server.example.com
  User dsh
  Port 22
  IdentityFile ~/.ssh/id_ed25519
  # ProxyJump bastion
```

应用中的 **SSH Host / 别名** 填 `my-dsh`，**DSH Web
端口**填远端实际端口。首次连接新主机前，请先在终端执行 `ssh my-dsh true`
完成主机密钥确认；桌面应用使用非交互模式并尊重 `.ssh/config` 中的 host-key 策略。

## 开发与检查

```bash
# 格式、lint、Desktop 类型检查和单元测试
deno task check

# 需要图形环境；使用 CEF 和热更新启动
deno task dev
```

运行时日志使用 Pino 10.1.0。Deno Desktop、命名权限集和 CEF/WebView2 后端均属于当前 Deno 2.9
的实验性契约。

## 构建

```bash
# 可直接运行的目录包
deno task build:linux
deno task build:windows          # 同时构建 Windows CEF 与 WebView2
deno task build:macos:aarch64
deno task build:macos:x86_64

# 也可只构建一个 Windows 后端
deno task build:windows:cef
deno task build:windows:webview

# 便于分发的产物
deno task package:linux          # AppImage
deno task package:windows        # 同时生成两个 Windows 完整目录 ZIP
deno task package:macos:aarch64  # Apple Silicon .app tar.gz
deno task package:macos:x86_64   # Intel .app tar.gz
```

目录包输出到：

- Linux：`dist/linux/DSH-Desktop/`
- Windows CEF：`dist/windows/DSH-Desktop-CEF/`
- Windows WebView2：`dist/windows/DSH-Desktop-WebView/`
- macOS arm64：`dist/macos/aarch64/DSH-Desktop.app`
- macOS x86_64：`dist/macos/x86_64/DSH-Desktop.app`

Deno 会按目标平台下载并校验对应 backend；CEF 首次构建较慢且产物体积较大，WebView2 使用系统 Runtime。
两个 Windows ZIP 与两个 macOS `.app` tar.gz 均在 Linux 交叉编译打包；目标系统 CI 只运行源码检查和
单元测试。Windows 构建会使用固定版本的 `resedit` 把 ICO 写入 launcher 的 PE 资源，因为 Deno 2.9 的
`--icon` 只复制旁置 `AppIcon.ico`。Windows 发布产物都是完整应用目录 ZIP，无需安装或管理员权限；关闭
应用后用同后端的新目录覆盖即可更新。GUI 行为仍需在目标系统验证。

Linux 构建和 AppImage 任务继续保留给源码用户自行执行；CI 与 `latest` Release 不提供 Linux 预构建包。

## Latest Release

固定下载地址：[`releases/tag/latest`](https://github.com/Diluka/dsh-desktop-app/releases/tag/latest)。每次成功的
`main` 流水线会覆盖其中的同名分发产物。各文件的用途与安装方式见
[发布制品说明](docs/RELEASE_ARTIFACTS.md)。

`main` 的 CI 依次执行四平台测试、Windows/macOS 四种分发产物构建和 `latest` Release
更新。只有前一阶段全部成功才会进入下一阶段；任何测试或打包失败都会保留上一版 Release。Pull Request
只运行测试，不发布产物。

## 日志

每个进程使用独立的 JSONL
文件，文件名使用纳秒精度启动时间，不会与其他进程混写。服务器选择页可直接打开日志目录：

- Linux：`$XDG_STATE_HOME/dsh-desktop/logs/`，未设置时为 `~/.local/state/dsh-desktop/logs/`
- Windows：`%LOCALAPPDATA%\dsh-desktop\logs\`
- macOS：`~/Library/Logs/dsh-desktop/`

正常连接的主要事件顺序：

```text
app.start
ssh.probe
ssh.tunnel_starting
ssh.tunnel_ready
...
app.shutdown
ssh.tunnel_exited
app.stopped
```

失败时先在 JSONL 中查看 `childOutputFile`，再检查对应的 `.child.log`。子进程正常运行时应用不读取
该文件；只有启动失败或意外退出后才读取文件尾部，用于错误分类和界面提示。

Pino JSONL 会对常见的 password、passphrase、token、Bearer 凭据和私钥标记做持久化前脱敏，也不记录
内部页面 URL。`.child.log` 直接接收 `dsh` 或 OpenSSH 的原始 stdout/stderr，不经过脱敏，外发前请检查
其中的 Host、用户名、本地路径和其他敏感内容。POSIX 平台创建文件时使用 `0600`；Windows 文件继承
`%LOCALAPPDATA%\dsh-desktop\logs` 的访问控制列表。

完整 GUI 验证与日志回传步骤见 [`docs/GUI_TESTING.md`](docs/GUI_TESTING.md)。

## 安全边界

- `dsh` 和 SSH 通过 `child_process.spawn` 参数数组启动，不经过 shell；Windows 使用
  `windowsHide: true`。
- 转发固定为 `127.0.0.1:<自动端口> -> 127.0.0.1:<远端 DSH 端口>`。
- `BatchMode=yes` 防止无界面的密码提示卡住应用。
- 主机密钥校验沿用用户 `.ssh/config` 与 OpenSSH 默认策略，应用不会降低现有策略。
- 启动 `dsh` 和 OpenSSH 并完整继承其环境需要运行时 `run/env` 权限。
- Pino 加载时只额外开放 `sys.hostname`；文件日志的基础字段包含进程 `pid`。
- Windows CEF 通过 FFI 加载系统目录中的 `user32.dll`，用于给原生窗口设置已打包的应用图标；远端页面
  没有 FFI binding。
- 远端 DSH 页面加载前会移除配置、删除和连接 bindings。

## 项目结构

```text
app.ts              共享桌面生命周期、bindings 与安全导航
main.ts             CEF 入口
main_webview.ts     WebView2 入口
assets/             SVG 源图、1024px PNG、Windows ICO 与 macOS ICNS
scripts/            平台打包辅助脚本
src/profiles.ts     服务器配置校验和持久化
src/ssh_tunnel.ts   OpenSSH 探测、隧道和错误分类
src/local_dsh.ts    本地 DSH Web 启动、探测和错误分类
src/loopback_http.ts 回环端口分配与 HTTP 就绪探测
src/hidden_process.ts 隐藏进程、独立输出文件与退出状态适配
src/open_directory.ts 系统文件管理器调用
src/windows_window_icon.ts Windows 原生窗口图标
src/browser_locale.ts 运行时系统 locale 检测
src/logger.ts       Pino 文件日志配置与脱敏
src/ui.ts           本地服务器选择页
src/app_paths.ts    Windows/Linux/macOS 应用数据路径
tests/              无头单元测试
docs/               GUI 验证说明
```

## 已知限制

- macOS `.app` 由 Linux 交叉构建，未进行 Apple Developer ID 签名或 notarization；真实 GUI
  行为仍等待实机验证。
- SSH 密码与私钥 passphrase 不提供应用内交互，请通过 `ssh-agent`
  解锁密钥，或配置专用的非交互认证方式。
- 断线后会返回服务器选择页，目前不自动重连。
