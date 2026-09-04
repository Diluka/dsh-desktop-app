<p align="center">
  <img src="assets/icon.svg" width="128" alt="DSH Desktop 图标">
</p>

<h1 align="center">DSH Desktop</h1>

<p align="center">
  在桌面窗口中启动本地 DSH Web，或通过 OpenSSH 安全连接远端 DSH Web。
</p>

<p align="center">
  <a href="https://github.com/Diluka/dsh-desktop-app/actions/workflows/ci.yml"><img src="https://github.com/Diluka/dsh-desktop-app/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/Diluka/dsh-desktop-app/releases/tag/latest">下载最新版本</a>
</p>

DSH Desktop 是 DSH Web 的跨平台桌面入口。它可以直接运行本机的 `dsh web`，也可以通过系统 OpenSSH
建立回环端口转发，在同一窗口中打开远端 DSH Web。

## 功能

- **本地模式**：优先运行用户环境中的 `dsh`；不可用时，用户点击启动后再通过 npx 获取并运行 DSH。
- **远程模式**：复用用户的 OpenSSH 配置、密钥、`ssh-agent`、`ProxyJump` 和主机密钥策略。
- **原生桌面窗口**：Windows 提供 CEF 与 WebView2 两种版本，macOS 和 Linux 使用 CEF。
- **持久化入口**：保存远程服务器、连接模式和最近使用的远程项目。
- **更新检查**：Windows/macOS 发行包会比对 `latest` Release 的来源
  commit，发现新版本时提示打开下载页。

> [!IMPORTANT]
> 项目基于实验性的 `deno desktop`。
>
> Windows WebView2 版本依赖 Microsoft Edge WebView2 Runtime；CEF 版本自带 Chromium，因此包体更大。

## 下载

Windows 和 macOS 用户可以从
[`latest` Release](https://github.com/Diluka/dsh-desktop-app/releases/tag/latest)
下载并完整解压对应平台的包：

| 平台                | 可用版本                                |
| ------------------- | --------------------------------------- |
| Windows x86_64      | CEF、WebView2                           |
| macOS Apple Silicon | CEF `.app`                              |
| macOS Intel         | CEF `.app`                              |
| Linux x86_64        | 从源码构建；当前不提供 Release 预构建包 |

包名、后端区别、macOS
首次启动方式和更新规则见[发布制品说明](docs/RELEASE_ARTIFACTS.md)。发行包会在构建前写入来源 commit
id；开发构建保持 `development`，不会检查更新。

## 快速使用

### 本地模式

1. 确认终端中至少有一个可用命令：`dsh --version` 或 `npx --version`。
2. 打开 DSH Desktop，选择**本地模式**。
3. 环境检测完成后，点击**启动本地 DSH**。

应用启动阶段只检查工具版本。只有在用户点击启动、且本机没有可用 `dsh` 时，才会执行
`npx -y @deepseek-ai/dsh`；首次下载可以在等待窗口中取消。

### 远程模式

远程机器需要在回环地址运行 DSH Web，本机需要可用的 OpenSSH Client。建议先配置 SSH Host 别名：

```sshconfig
Host my-dsh
  HostName server.example.com
  User dsh
  IdentityFile ~/.ssh/id_ed25519
```

首次连接前，在终端完成主机密钥确认并验证非交互认证：

```bash
ssh my-dsh true
```

随后在 DSH Desktop 中添加 `my-dsh`，填写远端 DSH Web 端口（默认 `3080`）并连接。如果远端新版 DSH Web
启动时打印了 `token`，可把 token 填入服务器配置并保存；旧版 DSH 或没有 token 时留空即可。
应用连接时始终把保存的字段作为 `token` query 参数带到隧道 URL 上，并用 HTML 探针读取状态码；
如果远端返回登录要求，界面会提示输入新的 token。应用使用密钥或 `ssh-agent`，不提供 SSH 密码和私钥
passphrase 的交互输入。

## 开发

CI 使用 Deno `2.9.5`。安装兼容版本后运行：

```bash
# 格式检查、lint、类型检查和单元测试
deno task check

# 使用 CEF 与 HMR 启动开发窗口
deno task dev
```

完整的运行边界、配置与日志路径、构建任务、安全模型和源码导览见[开发文档](docs/DEVELOPMENT.md)。

## 文档

- [开发、构建与运行边界](docs/DEVELOPMENT.md)
- [发布制品说明](docs/RELEASE_ARTIFACTS.md)
- [Windows / Linux / macOS GUI 验证](docs/GUI_TESTING.md)
