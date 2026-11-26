param(
  [Parameter(Mandatory=$true)][string]$Script,
  [string]$Json = '{}',
  [int]$TimeoutSec = 600
)
# 通用 lceda-pro invoke 封装：跑脚本 + 打印 JSON
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'tool-paths.ps1')
$cli = Resolve-LcedaCli
$sidFile = Join-Path (Split-Path -Parent $PSScriptRoot) '.session'
if (-not (Test-Path $sidFile)) { throw "no session file; run ensure-session first" }
$sid = (Get-Content $sidFile -Raw).Trim()

$out = (& $cli invoke --session $sid --ext-uuid eda --code-file $Script --args $Json --timeout (($TimeoutSec+60)*1000) 2>&1 | Out-String)
$out
