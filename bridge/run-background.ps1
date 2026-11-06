# 适用于计划任务；不依赖特定机器上的 Node 安装路径。
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
& $node (Join-Path $PSScriptRoot 'background-host.js')
exit $LASTEXITCODE
