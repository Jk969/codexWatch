# 计划任务持有桥接进程，不随 Codex 窗口或账号切换结束。
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
& 'D:/soft/nvm4w/nodejs/node.exe' background-host.js
exit $LASTEXITCODE
