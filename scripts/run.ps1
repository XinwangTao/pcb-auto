param(
  [Parameter(Mandatory=$true)][string]$Script,
  [string]$Json = '{}',
  [int]$TimeoutSec = 600
)
# 通用 lceda-pro invoke 封装：跑脚本 + 打印 JSON
$ErrorActionPreference = 'Stop'
$cli = 'E:\APP\lceda-pro\lceda-pro.exe'
$sidFile = 'D:\Users\陶鑫旺\Documents\deepseek-harness\default-workspace\pcb-auto\.session'
if (-not (Test-Path $sidFile)) { throw "no session file; run ensure-session first" }
$sid = (Get-Content $sidFile -Raw).Trim()

$out = (& $cli invoke --session $sid --ext-uuid eda --code-file $Script --args $Json --timeout (($TimeoutSec+60)*1000) 2>&1 | Out-String)
$out
