# 开发、构建与运行边界

本文记录 DSH Desktop 的运行契约、配置与日志位置、安全边界、开发流程和源码结构。下载包的选择见
[发布制品说明](RELEASE_ARTIFACTS.md)，真实桌面行为的验收步骤见 [GUI 验证](GUI_TESTING.md)。

## 运行模式

### 本地模式

应用启动后异步检查本地工具，并在选择页显示平台、Node.js、DSH CLI 和 npx 信息。启动资格只要求存在一个
可用 launcher：优先 `dsh`，否则使用 npx；Node.js 版本只作为诊断信息展示。

启动阶段允许执行的探测只有：

```text
node --version
dsh --version
npx --version
```

启动阶段不会执行 `npx -y @deepseek-ai/dsh --version`，也不会下载 DSH 包。Unix 平台使用用户默认 login
shell 完成一次环境探测，并通过同一 login-shell 机制启动实际命令，以继承 mise、nvm 等版本管理器环境。
Windows 通过系统命令解析可执行文件；`.cmd` launcher 由 `%ComSpec%` 执行固定参数。

实际启动命令等价于：

```text
dsh web --host 127.0.0.1 --port <自动端口> --no-open
```

找不到 `dsh` 且 npx 可用时，只有用户点击启动后才执行：

```text
npx -y @deepseek-ai/dsh web --host 127.0.0.1 --port <自动端口> --no-open
```

若 PATH 中存在 `dsh` 但其版本探测失败，应用不会用 npx 静默掩盖该故障。本地启动没有整体超时；首次 npx
下载可能持续较长时间，用户可以在等待窗口中终止进程。

### 远程模式

远程模式调用系统 OpenSSH，把自动分配的本地回环端口转发到远端
`127.0.0.1:<DSH Web 端口>`。应用把服务器字段作为 SSH Host 别名或 `user@host` 交给
OpenSSH，不自行解析 `HostName`、`User`、`Port`、`IdentityFile` 或 `ProxyJump`。

OpenSSH 使用以下固定选项：

```text
-N
-T
BatchMode=yes
ExitOnForwardFailure=yes
ConnectTimeout=12
ServerAliveInterval=30
ServerAliveCountMax=3
```

`BatchMode=yes` 表示应用不会弹出 SSH 密码或私钥 passphrase 输入框。请在用户 OpenSSH 配置中准备密钥或
`ssh-agent`，并在首次连接新主机前从终端执行：

```bash
ssh <Host别名> true
```

Windows 的 OpenSSH 配置通常位于 `%USERPROFILE%\.ssh\config`，Linux 和 macOS 位于
`~/.ssh/config`。远端 DSH Web 默认端口是 `3080`。

## 配置与偏好

服务器配置、选择的连接模式和最近使用的远程项目保存在同一个 `servers.json`：

| 平台    | 配置文件                                                                                     |
| ------- | -------------------------------------------------------------------------------------------- |
| Linux   | `$XDG_CONFIG_HOME/dsh-desktop/servers.json`；未设置时为 `~/.config/dsh-desktop/servers.json` |
| Windows | `%APPDATA%\dsh-desktop\servers.json`                                                         |
| macOS   | `~/Library/Application Support/dsh-desktop/servers.json`                                     |

配置文件包含 SSH Host、显示名称、远端 DSH Web 端口、连接模式和最近使用项目 ID。

损坏的 JSON 会在启动时重命名为带时间戳的 `.invalid-*` 备份，应用随后使用空配置启动。

## 日志与排障

选择页左下角的**打开目录**按钮可以打开当前日志目录：

| 平台    | 日志目录                                                                           |
| ------- | ---------------------------------------------------------------------------------- |
| Linux   | `$XDG_STATE_HOME/dsh-desktop/logs/`；未设置时为 `~/.local/state/dsh-desktop/logs/` |
| Windows | `%LOCALAPPDATA%\dsh-desktop\logs\`                                                 |
| macOS   | `~/Library/Logs/dsh-desktop/`                                                      |

每个应用进程写入独立的 `dsh-desktop-<纳秒时间>.jsonl`。Pino JSONL 对常见的 password、passphrase、
token、secret、Authorization、Bearer 凭据和私钥标记进行脱敏，并限制错误文本长度。

每个 `dsh`、npx 或 OpenSSH 子进程由操作系统直接把 stdout/stderr 写入独立 `.child.log`。
应用不会持续读取该文件；仅在启动失败或意外退出后读取末尾最多 16 KiB，用于错误分类和界面提示。

`.child.log` 是未经脱敏的原始输出，外发前需要检查 SSH Host、用户名、本地路径和其他敏感内容。POSIX
平台创建日志文件时使用 `0600`；Windows 文件继承日志目录的访问控制列表。

常见排障入口：

| 现象                 | 检查项                                                        |
| -------------------- | ------------------------------------------------------------- |
| 本地启动按钮禁用     | 选择页中的 DSH/npx 探测结果，以及 login shell 的 profile 配置 |
| npx 长时间等待       | 对应 `.child.log` 的下载输出；可以先终止，再在终端验证 npx    |
| OpenSSH 不可用       | `ssh -V`；Windows 可选功能或 Linux 的 `openssh-client` 包     |
| 主机不存在或认证失败 | `ssh <Host别名> true`、用户 OpenSSH 配置、密钥和 `ssh-agent`  |
| DSH Web 无法就绪     | 远端监听端口、远端回环地址和服务器配置中的 DSH Web 端口       |
| 连接后意外返回选择页 | JSONL 中的退出事件及其 `childOutputFile`                      |

完整的人工验证和日志回传模板见 [GUI 验证](GUI_TESTING.md)。

## 安全边界

- 所有本地 Web 地址和 SSH 转发只绑定回环地址，不向局域网暴露监听端口。
- OpenSSH 使用参数数组直接启动，不经过 shell 拼接。
- Unix 的 `dsh`/npx 由 login shell 通过固定位置参数 `exec`；Windows `.cmd` launcher 使用固定
  `%ComSpec%` 参数。用户输入不会拼接进 shell 脚本。
- 选择页的配置、删除和连接 bindings 会在导航到 DSH Web 前解除；远端页面无法调用这些桌面特权操作。
- Windows CEF 仅通过系统 `user32.dll` 设置原生窗口图标；远端页面没有 FFI binding。
- Deno 权限集允许读取和写入用户配置/日志、启动本地命令、访问回环网络，并为 Pino 开放主机名查询。

## 开发环境

CI 使用 Deno `2.9.5`。`deno desktop`、命名权限集及 CEF/WebView2 后端仍属于实验性契约。

升级 Deno 时需要重新验证构建产物和真实 GUI 行为。

常用任务：

```bash
# 只检查格式
deno fmt --check

# 完整源码检查和单元测试
deno task check

# 使用 CEF 与 HMR 启动开发窗口
deno task dev
```

`deno task check` 依次执行格式检查、lint、Desktop 类型检查和带 `app` 权限集的单元测试。

## 构建与打包

### 可运行目录包

| 任务                              | 输出                                 |
| --------------------------------- | ------------------------------------ |
| `deno task build:linux`           | `dist/linux/DSH-Desktop/`            |
| `deno task build:windows:cef`     | `dist/windows/DSH-Desktop-CEF/`      |
| `deno task build:windows:webview` | `dist/windows/DSH-Desktop-WebView/`  |
| `deno task build:windows`         | 同时构建两个 Windows 后端            |
| `deno task build:macos:aarch64`   | `dist/macos/aarch64/DSH-Desktop.app` |
| `deno task build:macos:x86_64`    | `dist/macos/x86_64/DSH-Desktop.app`  |

### 分发包

| 任务                                | 输出                                                  |
| ----------------------------------- | ----------------------------------------------------- |
| `deno task package:linux`           | `dist/linux/DSH-Desktop.AppImage`                     |
| `deno task package:windows:cef`     | `dist/windows/DSH-Desktop-windows-x86_64-cef.zip`     |
| `deno task package:windows:webview` | `dist/windows/DSH-Desktop-windows-x86_64-webview.zip` |
| `deno task package:windows`         | 同时生成两个 Windows ZIP                              |
| `deno task package:macos:aarch64`   | `dist/macos/DSH-Desktop-macos-aarch64.tar.gz`         |
| `deno task package:macos:x86_64`    | `dist/macos/DSH-Desktop-macos-x86_64.tar.gz`          |

Windows 构建脚本会规范化 launcher/runtime 文件名，并使用固定版本的 `resedit` 把项目 ICO 写入 PE
资源。Windows ZIP 和 macOS tar.gz 可以在 Linux CI 上交叉构建。macOS `.app` 当前未进行 Apple
Developer ID 签名或 notarization。

Linux 目录包和 AppImage 任务供源码用户使用；滚动 `latest` Release 当前只发布 Windows 与 macOS 包。
详见[发布制品说明](RELEASE_ARTIFACTS.md)。

## CI 与发布

Pull Request 会运行：

- Linux x86_64、Windows x86_64、macOS arm64、macOS x86_64 源码检查和单元测试；
- Linux mise 与 nvm login-shell 环境验证。

`main` 上述检查全部成功后，CI 在 Linux 上交叉构建四个 Windows/macOS 分发包，再更新滚动 `latest`
Release。发布任务会确认运行对应当前 `main`，防止较旧的工作流覆盖较新的制品。

## 源码结构

```text
app.ts                    桌面生命周期、bindings 与安全导航
main.ts                   CEF 入口
main_webview.ts           WebView2 入口
assets/                   SVG、PNG、Windows ICO 与 macOS ICNS
scripts/                  Windows 打包与 toolchain 环境验证
src/app_paths.ts          跨平台配置和日志路径
src/hidden_process.ts     隐藏子进程与独立输出文件
src/local_dsh.ts          本地 DSH/npx 探测与启动
src/managed_endpoint.ts   子进程停止与退出生命周期
src/profiles.ts           服务器配置和偏好持久化
src/ssh_tunnel.ts         OpenSSH 隧道与错误分类
src/ui.html               本地选择页的结构、样式和交互
src/ui.ts                 本地选择页 HTTP 响应与安全头
tests/                    无头单元测试
docs/                     开发、发布和 GUI 验证文档
```

## 当前限制

- OpenSSH 认证依赖密钥或 `ssh-agent`，应用不提供密码和 passphrase 交互。
- SSH 或本地 DSH 进程意外退出后会返回选择页，目前不自动重连。
- macOS 分发包未签名和 notarize，首次打开可能需要通过 Finder 确认。
- 真实窗口、图标、WebView2 Runtime 和平台集成行为仍需按照 [GUI 验证](GUI_TESTING.md)
  在目标系统检查。
