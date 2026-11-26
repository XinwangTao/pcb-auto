# d7d8-run.ps1 —— d7/d8 复现与阶段计时（只读诊断用，不碰 .session / _args_live.json / out\）
#
# 与 run-all.ps1 的差别（故意）：每次都用**自己的新 session**，超时值可调，
# 落盘 pipeline3.js 返回的完整 log 数组，便于按 PHASE 分析阶段耗时。
#
# 用法：
#   pwsh -NoProfile -File scripts\d7d8-run.ps1 -Which d8 -Tag d8-full                 # 设计原板框
#   pwsh -NoProfile -File scripts\d7d8-run.ps1 -Which d7 -Tag d7-small -W 1200 -H 900 # 小板框外推
#   pwsh -NoProfile -File scripts\d7d8-run.ps1 -Which d7 -Tag d7-full -TimeoutMs 1800000
#
# 产物：
#   logs\diag-<Tag>.json      pipeline3.js 完整返回值（含 log 阶段数组）—— 诊断主证据
#   logs\diag-<Tag>.raw.txt   CLI 原始 stdout（超时/信封错误时唯一证据）
#   diag-out\<Tag>\           EDA 导出产物（独立目录，不会被 scripts\cleanup.ps1 扫到）
param(
  [Parameter(Mandatory = $true)][ValidateSet('d7', 'd8')][string]$Which,
  [Parameter(Mandatory = $true)][string]$Tag,
  [int]$W = 0,
  [int]$H = 0,
  [int]$TimeoutMs = 900000,
  [switch]$ReuseSession
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$CLI = 'E:\APP\lceda-pro\lceda-pro.exe'
$SessFile = Join-Path $Root 'scripts\.d7d8-session'
$LogDir = Join-Path $Root 'logs'
$OutDir = Join-Path $Root "diag-out\$Tag"
New-Item -ItemType Directory -Force -Path $LogDir, $OutDir | Out-Null
$OutDir = [IO.Path]::GetFullPath($OutDir)   # 必须绝对路径，否则 6 个导出静默失败

function Log($m, $c = 'Cyan') { Write-Host "[d7d8] $m" -ForegroundColor $c }

# ---------- 1. 自己的 session（绝不复用 .session：无人值守循环在用） ----------
function Test-Alive([string]$sid) {
  if (-not $sid) { return $false }
  try {
    $o = (& $CLI invoke --session $sid --ext-uuid eda --code 'return 1' --timeout 30000 2>&1 | Out-String)
    return [bool](($o | ConvertFrom-Json).ok)
  } catch { return $false }
}
$sid = $null
if ($ReuseSession -and (Test-Path $SessFile)) {
  $old = (Get-Content $SessFile -Raw).Trim()
  if (Test-Alive $old) { $sid = $old; Log "复用诊断会话 $sid" 'DarkYellow' }
}
if (-not $sid) {
  $o = (& $CLI open --headless true 2>&1 | Out-String)
  $sid = $null
  try { $sid = ($o | ConvertFrom-Json).value.sessionId } catch { }
  if (-not $sid) { throw "open 失败：$($o.Substring(0,[Math]::Min(200,$o.Length)))" }
  Set-Content -Path $SessFile -Value $sid -NoNewline
  Log "新诊断 session = $sid"
}

# ---------- 2. 组参数 ----------
$designPath = Join-Path $Root "designs\$($Which -replace '^d','d')-*.json"
$designFile = switch ($Which) {
  'd7' { Join-Path $Root 'designs\d7-rp2040-flash.json' }
  'd8' { Join-Path $Root 'designs\d8-led-8ch.json' }
}
$designObj = Get-Content $designFile -Raw | ConvertFrom-Json
if ($W -gt 0) { $designObj.boardWidthMil = $W }
if ($H -gt 0) { $designObj.boardHeightMil = $H }
$argsFile = Join-Path $Root "scripts\d7d8-args-$Tag.json"
Set-Content -Path $argsFile -Encoding UTF8 -Value (ConvertTo-Json -Compress -Depth 20 @{ design = $designObj; outDir = $OutDir })

Log ("板框 {0}x{1} mil  超时 {2}ms  outDir {3}" -f $designObj.boardWidthMil, $designObj.boardHeightMil, $TimeoutMs, $OutDir)

# ---------- 3. 跑 ----------
$sw = [Diagnostics.Stopwatch]::StartNew()
$raw = (& $CLI invoke --session $sid --ext-uuid eda --code-file (Join-Path $Root 'scripts\pipeline3.js') `
        --args (Get-Content $argsFile -Raw) --timeout $TimeoutMs 2>&1 | Out-String)
$sw.Stop()
$wallMs = [int]$sw.Elapsed.TotalMilliseconds
Set-Content -Path (Join-Path $LogDir "diag-$Tag.raw.txt") -Value $raw -Encoding UTF8

$envl = $null
try { $envl = $raw | ConvertFrom-Json } catch { Log '输出不是 JSON（超时或会话错误，见 raw.txt）' 'Red' }
$diag = [ordered]@{
  tag = $Tag; design = $designFile
  boardMil = "$($designObj.boardWidthMil)x$($designObj.boardHeightMil)"
  timeoutMs = $TimeoutMs; wallMs = $wallMs; session = $sid
  cli = if ($envl) { [ordered]@{ ok = $envl.ok; error = $envl.error; durationMs = $envl.durationMs } } else { $null }
  phases = @(); value = if ($envl -and $envl.ok) { $envl.value } else { $null }
}
if ($envl -and $envl.ok -and $envl.value) {
  $v = $envl.value
  $prev = 0
  foreach ($e in @($v.log)) {
    if ($e.s -ne 'PHASE') { continue }
    $ms = [int]$e.v.ms
    $diag.phases += [ordered]@{ phase = $e.v.n; startMs = $ms; durMs = $ms - $prev }
    $prev = $ms
  }
  if ($diag.phases.Count) {
    $diag.phases[-1].durMs = [int]$v.elapsedMs - ($diag.phases[-1].startMs - $diag.phases[-1].durMs)
  }
}
Set-Content -Path (Join-Path $LogDir "diag-$Tag.json") -Encoding UTF8 -Value (ConvertTo-Json $diag -Depth 30)

# ---------- 4. 汇总 ----------
if ($envl -and $envl.ok -and $envl.value) {
  $v = $envl.value
  Log ("完成 elapsed={0:N1}s ok={1} route={2} drc={3} 违规={4}" -f ($v.elapsedMs/1000), $v.ok, $v.routeState, $v.drcPassed, $v.drcDetailCount) 'Green'
  foreach ($p in $diag.phases) { Write-Host ("    {0,-16} {1,8:N1}s" -f $p.phase, ($p.durMs/1000)) }
} else {
  Log ("未拿到结果：wall={0:N1}s  exit={1}" -f ($wallMs/1000), $LASTEXITCODE) 'Red'
  Write-Host $raw
}
exit 0
