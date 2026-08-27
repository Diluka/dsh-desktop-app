# run-fake-dsh-test.ps1
# 一键用 fake-dsh 启动 DSH Desktop 并验证进程清理，无需本机安装 dsh。
# 用法：把本文件和 fake-dsh.ps1/fake-dsh.cmd/fake-dsh.js 放到 DSH-Desktop.exe 同目录，
#       运行  .\run-fake-dsh-test.ps1
$ErrorActionPreference = "Continue"

$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$app  = Join-Path $root "DSH-Desktop.exe"
$bin  = Join-Path $env:USERPROFILE "fake-dsh-bin"

Write-Host "== 1/6 准备 fake-dsh bin: $bin"
New-Item -ItemType Directory -Force $bin | Out-Null
Copy-Item (Join-Path $root "fake-dsh.ps1") (Join-Path $bin "dsh.ps1")  -Force
Copy-Item (Join-Path $root "fake-dsh.cmd") (Join-Path $bin "dsh.cmd")  -Force
Copy-Item (Join-Path $root "fake-dsh.js")  (Join-Path $bin "fake-dsh.js") -Force

Write-Host "== 2/6 清理上次残留进程"
Get-Process DSH-Desktop, node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

$env:PATH = "$bin;$env:PATH"

Write-Host "== 3/6 启动 DSH Desktop（fake-dsh 已在 PATH 最前）"
$appProc = Start-Process -FilePath $app -PassThru
Write-Host "   DSH-Desktop PID = $($appProc.Id)"

# 后台每 3 秒抓一次进程树快照，存到临时文件
$snapshot = Join-Path $env:TEMP "dsh-fake-test-tree.txt"
Remove-Item $snapshot -ErrorAction SilentlyContinue
$snapJob = Start-Job -ScriptBlock {
  param($appPid, $snapshot)
  while ($null -ne (Get-Process -Id $appPid -ErrorAction SilentlyContinue)) {
    "----- $(Get-Date -Format o) -----" | Out-File -Append $snapshot
    Get-CimInstance Win32_Process `
      -Filter "Name='node.exe' OR Name='powershell.exe' OR Name='cmd.exe' OR Name='DSH-Desktop.exe'" |
      Select ProcessId, ParentProcessId, Name, CommandLine |
      Format-List | Out-File -Append $snapshot
    Start-Sleep -Seconds 3
  }
} -ArgumentList $appProc.Id, $snapshot

Write-Host ""
Write-Host "== 4/6 请手动操作应用："
Write-Host "   1) 窗口里点 本地模式"
Write-Host "   2) 点 启动本地 DSH（应秒开，无下载）"
Write-Host "   3) 看到 fake dsh web 加载后，关闭窗口"
Write-Host ""
Write-Host "== 等待应用退出（最多 3 分钟；若一直不退说明进程卡住，脚本会自动结束它）..."
$deadline = (Get-Date).AddMinutes(3)
while ((Get-Date) -lt $deadline -and $null -ne (Get-Process -Id $appProc.Id -ErrorAction SilentlyContinue)) {
  Start-Sleep -Seconds 1
}
Stop-Job $snapJob -ErrorAction SilentlyContinue
Remove-Job $snapJob -ErrorAction SilentlyContinue
if ($null -ne (Get-Process -Id $appProc.Id -ErrorAction SilentlyContinue)) {
  Write-Host "!! 3 分钟内应用进程未退出（疑似卡在清理流程）。已强制结束。"
  Stop-Process -Id $appProc.Id -Force -ErrorAction SilentlyContinue
} else {
  Write-Host "应用进程已退出。"
}

Write-Host ""
Write-Host "== 5/6 运行期进程树快照（最后一段）"
if (Test-Path $snapshot) {
  Get-Content $snapshot | Select-Object -Last 45
} else {
  Write-Host "(无快照)"
}

Write-Host ""
Write-Host "== 6/6 残留检查"
Start-Sleep -Seconds 2
$left = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like "*fake-dsh*" -or $_.CommandLine -like "*setInterval*" }
if ($left) {
  Write-Host "发现残留："
  $left | Select ProcessId, ParentProcessId, Name, CommandLine | Format-List
} else {
  Write-Host "无残留（node / powershell 均已退出）"
}

Write-Host ""
Write-Host "== 最新应用日志"
$log = Get-ChildItem (Join-Path $env:LOCALAPPDATA "dsh-desktop\logs\*.jsonl") -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime | Select-Object -Last 1
if ($log) {
  Write-Host $log.FullName
  Get-Content $log.FullName
} else {
  Write-Host "(无日志)"
}
Write-Host ""
Write-Host "== 完成。把上面 5/6 快照、6/6 残留和日志发给我。"
