# run-fake-dsh-test.ps1
# 用 fake-dsh 一键启动 DSH Desktop 并验证进程清理（无需本机安装 dsh）。
# 把 dsh.ps1/dsh.cmd/fake-dsh.js 和 DSH-Desktop.exe 放同一目录，运行 .\run-fake-dsh-test.ps1
$ErrorActionPreference = "Continue"

$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$app  = Join-Path $root "DSH-Desktop.exe"

Write-Host "== 1/5 清理上次残留进程"
Get-Process DSH-Desktop, node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

# fake-dsh 就在本目录，把本目录放到 PATH 最前，应用就能发现 dsh.ps1
$env:PATH = "$root;$env:PATH"

Write-Host "== 2/5 启动 DSH Desktop（本目录已在 PATH 最前）"
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
Write-Host "== 3/5 请手动操作应用："
Write-Host "   1) 点 本地模式"
Write-Host "   2) 点 启动本地 DSH（秒开，无下载）"
Write-Host "   3) 看到 fake dsh web 后关闭窗口"
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
Write-Host "== 4/5 运行期进程树快照（最后一段）"
if (Test-Path $snapshot) {
  Get-Content $snapshot | Select-Object -Last 45
} else {
  Write-Host "(无快照)"
}

Write-Host ""
Write-Host "== 5/5 残留检查 + 日志"
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
$log = Get-ChildItem (Join-Path $env:LOCALAPPDATA "dsh-desktop\logs\*.jsonl") -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime | Select-Object -Last 1
if ($log) {
  Write-Host $log.FullName
  Get-Content $log.FullName
} else {
  Write-Host "(无日志)"
}
Write-Host ""
Write-Host "== 完成。把 4/5 快照、5/5 残留和日志发我。"
