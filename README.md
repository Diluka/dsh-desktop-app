# DSH Desktop

[![CI](https://github.com/Diluka/dsh-desktop-app/actions/workflows/ci.yml/badge.svg)](https://github.com/Diluka/dsh-desktop-app/actions/workflows/ci.yml)

DSH 的 Windows、Linux 与 macOS 桌面入口。首版提供远程模式：选择服务器后，应用调用本机 OpenSSH Client
建立本地端口转发，再用内置 Chromium（CEF）打开远端 DSH Web。

> [!IMPORTANT]
> `deno desktop` 从 Deno 2.9 开始提供，目前仍标记为 experimental。项目固定使用 `cef` 后端，以换取
> Windows、Linux 与 macOS 一致的 Chromium 渲染行为。

## 当前范围

- 服务器配置保存 SSH Host/别名和远端 DSH Web 端口，端口默认 `3080`。
- OpenSSH 自动读取 `~/.ssh/config`，原生支持其中的用户、端口、密钥、`ProxyJump` 和其他选项。
- 本地转发只绑定 `127.0.0.1`，空闲端口由应用自动选择。
- SSH 成功后移除选择页的本地 bindings，再导航到 DSH Web。
- Pino JSONL 日志记录启动、配置、OpenSSH、隧道和退出生命周期。
- 所有平台都只启动一个 CEF 进程；系统 locale 仅写入日志，界面语言使用 DSH 已保存的偏好。
- 支持 Windows x86_64、Linux x86_64、macOS arm64 与 macOS x86_64 构建。

首版认证使用密钥或 `ssh-agent`，不在应用内接收或保存 SSH 密码、私钥内容和 passphrase。

## 前置条件

开发与构建需要：

- [Deno 2.9+](https://docs.deno.com/runtime/desktop/)
- Windows 10/11、现代 x86_64 Linux，或 Intel/Apple Silicon macOS
- PATH 中可用的 OpenSSH Client（`ssh -V`）
- 远端机器上已启动的 DSH Web

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

运行时日志使用 Pino 10.1.0。Deno Desktop、命名权限集和 CEF 后端均属于当前 Deno 2.9 的实验性契约。

## 构建

```bash
# 可直接运行的目录包
deno task build:linux
deno task build:windows
deno task build:macos:aarch64
deno task build:macos:x86_64

# 便于分发的产物
deno task package:linux          # AppImage
deno task package:windows        # 完整目录 ZIP
deno task package:macos:aarch64  # Apple Silicon DMG
deno task package:macos:x86_64   # Intel DMG
```

目录包输出到：

- Linux：`dist/linux/DSH-Desktop/`
- Windows：`dist/windows/DSH-Desktop/`
- macOS arm64：`dist/macos/aarch64/DSH-Desktop.app`
- macOS x86_64：`dist/macos/x86_64/DSH-Desktop.app`

Deno 会按目标平台下载并校验对应的 CEF 后端，因此首次构建较慢且产物体积较大。目录包可以交叉构建；DMG
依赖 macOS 的 `hdiutil`，由对应的 GitHub macOS runner 原生生成。Windows 构建会使用固定版本的
`resedit` 把 ICO 写入 launcher 的 PE 资源，因为 Deno 2.9 的 `--icon` 只复制旁置
`AppIcon.ico`。Windows 发布产物是完整应用目录
ZIP，无需安装或管理员权限；关闭应用后用新目录覆盖即可更新。GUI 行为仍需在目标系统验证。

Linux 构建和 AppImage 任务继续保留给源码用户自行执行；CI 与 `latest` Release 不提供 Linux 预构建包。

## Latest Release

固定下载地址：[`releases/tag/latest`](https://github.com/Diluka/dsh-desktop-app/releases/tag/latest)。每次成功的
`main` 流水线会覆盖其中的同名分发产物。

`main` 的 CI 依次执行四平台测试、Windows/macOS 三种分发产物构建和 `latest` Release
更新。只有前一阶段全部成功才会进入下一阶段；任何测试或打包失败都会保留上一版 Release。Pull Request
只运行测试，不发布产物。

## 日志

每次运行使用一个 `sessionId`，日志按天写入 JSONL。服务器选择页可直接打开日志目录：

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

失败时重点查看 `ssh.stderr` 与 `ssh.connect_failed`。日志会对常见的
password、passphrase、token、Bearer 凭据和私钥标记做持久化前脱敏，也不记录内部页面 URL；OpenSSH
自己的诊断仍可能包含 Host、用户名或本地文件路径，外发前请按需脱敏。

完整 GUI 验证与日志回传步骤见 [`docs/GUI_TESTING.md`](docs/GUI_TESTING.md)。

## 安全边界

- SSH 通过 `child_process.spawn` 参数数组启动，不经过 shell；Windows 使用 `windowsHide: true`。
- 转发固定为 `127.0.0.1:<自动端口> -> 127.0.0.1:<远端 DSH 端口>`。
- `BatchMode=yes` 防止无界面的密码提示卡住应用。
- 主机密钥校验沿用用户 `.ssh/config` 与 OpenSSH 默认策略，应用不会降低现有策略。
- 启动 OpenSSH 并完整继承其环境需要运行时 `run/env` 权限；代码只启动 `ssh`。
- Pino 加载时只额外开放 `sys.hostname`；文件日志的基础字段仅包含随机 `sessionId`。
- Windows 通过 FFI 加载系统目录中的 `user32.dll`，用于给原生窗口设置已打包的应用图标；远端页面没有
  FFI binding。
- 远端 DSH 页面加载前会移除配置、删除和连接 bindings。

## 项目结构

```text
main.ts             桌面生命周期、bindings 与安全导航
assets/             SVG 源图、1024px PNG、Windows ICO 与 macOS ICNS
scripts/            平台打包辅助脚本
src/profiles.ts     服务器配置校验和持久化
src/ssh_tunnel.ts   OpenSSH 探测、隧道和错误分类
src/hidden_process.ts Windows 隐藏进程与安全生命周期适配
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

- 本地模式尚未实现。
- macOS 已纳入 CI 构建，但真实 GUI 行为仍等待实机验证；DMG 当前使用 ad-hoc 签名。
- SSH 密码与私钥 passphrase 不提供应用内交互，请通过 `ssh-agent`
  解锁密钥，或配置专用的非交互认证方式。
- 断线后会返回服务器选择页，目前不自动重连。
