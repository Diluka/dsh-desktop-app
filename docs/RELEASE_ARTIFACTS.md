# 发布制品说明

`latest` Release
提供四个可下载文件。所有制品都来自同一提交，并在四个平台的源码检查与单元测试通过后由 Linux
交叉构建。

| 文件                                     | 目标系统            | 渲染后端                | 适用场景                                                             |
| ---------------------------------------- | ------------------- | ----------------------- | -------------------------------------------------------------------- |
| `DSH-Desktop-windows-x86_64-cef.zip`     | Windows x86_64      | 内置 Chromium（CEF）    | 希望应用自带固定浏览器内核，或目标机器无法确认 WebView2 Runtime 状态 |
| `DSH-Desktop-windows-x86_64-webview.zip` | Windows x86_64      | Microsoft Edge WebView2 | 希望下载体积更小，且目标机器已安装 WebView2 Runtime                  |
| `DSH-Desktop-macos-aarch64.tar.gz`       | Apple Silicon macOS | 内置 Chromium（CEF）    | M 系列 Mac                                                           |
| `DSH-Desktop-macos-x86_64.tar.gz`        | Intel macOS         | 内置 Chromium（CEF）    | Intel Mac                                                            |

## Windows CEF

CEF ZIP 包含 Chromium 运行库，因此目录较大，渲染内核不依赖系统 Edge 版本。

1. 完整解压 ZIP。
2. 运行目录中的 `DSH-Desktop-CEF.exe`。
3. 更新时关闭应用，再用新版 CEF 完整目录替换旧目录。

## Windows WebView2

WebView2 ZIP 使用系统安装的 Microsoft Edge WebView2 Runtime，因此目录明显更小。Windows 10/11
通常已随 Edge 或系统组件安装该 Runtime；缺失时需先安装 Microsoft Edge WebView2 Evergreen Runtime。

1. 完整解压 ZIP。
2. 运行目录中的 `DSH-Desktop-WebView.exe`。
3. 更新时关闭应用，再用新版 WebView2 完整目录替换旧目录。

两个 Windows 版本共享服务器配置和日志目录，可在同一台机器上分别测试。两者都依赖系统 OpenSSH
Client，都是便携目录应用，无需安装程序或管理员权限。

## macOS Apple Silicon

`DSH-Desktop-macos-aarch64.tar.gz` 包含完整 `.app`、CEF Framework 符号链接和可执行权限。使用系统
`tar` 解压：

```bash
tar -xzf DSH-Desktop-macos-aarch64.tar.gz
open DSH-Desktop.app
```

## macOS Intel

`DSH-Desktop-macos-x86_64.tar.gz` 面向 Intel Mac，解压与启动方式相同：

```bash
tar -xzf DSH-Desktop-macos-x86_64.tar.gz
open DSH-Desktop.app
```

两个 macOS 包均未进行 Apple Developer ID 签名和 notarization。首次启动时可在 Finder 中右键
`DSH-Desktop.app`，选择“打开”。

## Release 更新规则

`latest` 是滚动发布：新的 `main` 提交只有在 Linux、Windows、macOS
四个测试任务和四个分发构建全部成功后，才会替换现有文件。Release 页面会记录来源提交和 GitHub Actions
运行链接。

Linux 源码构建任务继续保留在仓库中，`latest` Release 当前不提供 Linux 预构建文件。
