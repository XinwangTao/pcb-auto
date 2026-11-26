# d7d8-repro-ghost.ps1 —— 复现"d7 超时 → d8 无声失败（SESSION_NOT_FOUND）"的因果链
#
# 假设：invoke --timeout 到期只是 CLI 放弃等待，**代码仍在 render 里跑**（CLI 帮助原文：
#   "the code is NOT interrupted and may keep running, its late result is discarded"）。
# run-all 在超时后立刻用**同一个 session** 重试下一个自愈方案 / 下一个设计 →
# 幽灵调用与新的 invoke 并发 → render 变慢/崩溃 → 下一次 invoke 返回非 JSON
# （SESSION_NOT_FOUND），run-all 只看到「输出不是 JSON」，最终 throw，日志里 策略=?。
#
# 步骤（全部用本脚本自己的 session，不碰 .session）：
#   1) 开自己的 session，先跑一次 d8（基线，约 250s）
#   2) 用 45s 超时跑 d7（故意让 CLI 放弃、幽灵继续跑）
#   3) 立刻在**同一 session** 上跑 d8 → 观察是否非 JSON / SESSION_NOT_FOUND / 变慢
#   4) session abort 杀掉幽灵，重新开 session，再跑 d8 → 应恢复正常
param(
  [string]$Tag = 'ghost',
  [int]$GhostTimeoutMs = 45000,
  # 与 run-all.ps1 的硬编码 --timeout 590000 完全一致，这样观察到的现象就是生产现象
  [int]$ProbeTimeoutMs = 590000
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'tool-paths.ps1')
$CLI = Resolve-LcedaCli
$LogDir = Join-Path $Root 'logs'
$OutRoot = Join-Path $Root 'diag-out'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$report = [ordered]@{ tag = $Tag; steps = @() }

function Log($m, $c = 'Cyan') { Write-Host "[ghost] $m" -ForegroundColor $c }
function New-Session {
  $o = (& $CLI open --headless true 2>&1 | Out-String)
  $sid = ($o | ConvertFrom-Json).value.sessionId
  if (-not $sid) { throw "open 失败: $o" }
  return $sid
}
# 跑一次 pipeline3.js，返回 { raw, isJson, ok, value, ms, err }
function Invoke-Design([string]$sid, [string]$design, [string]$tag, [int]$timeoutMs) {
  $outDir = [IO.Path]::GetFullPath((Join-Path $OutRoot "ghost-$tag"))
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  $d = Get-Content (Join-Path $Root $design) -Raw | ConvertFrom-Json
  $argsFile = Join-Path $Root "scripts\d7d8-args-$tag.json"
  Set-Content -Path $argsFile -Encoding UTF8 -Value (ConvertTo-Json -Compress -Depth 20 @{ design = $d; outDir = $outDir })
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $raw = (& $CLI invoke --session $sid --ext-uuid eda --code-file (Join-Path $Root 'scripts\pipeline3.js') `
          --args (Get-Content $argsFile -Raw) --timeout $timeoutMs 2>&1 | Out-String)
  $sw.Stop()
  $env = $null
  try { $env = $raw | ConvertFrom-Json } catch { }
  $isJson = [bool]$env
  $ok = if ($env) { [bool]$env.ok -and [bool]$env.value.ok } else { $false }
  $errCode = if ($env -and $env.error) { $env.error.code } else { '(非 JSON)' }
  $projUuid = if ($env -and $env.value) { $env.value.projectUuid } else { $null }
  $snap = $null
  if ($env -and $env.value) {
    $ph = @{}
    $prev = 0
    foreach ($e in @($env.value.log)) {
      if ($e.s -eq 'PHASE') { $ph[$e.v.n] = [int]$e.v.ms - $prev; $prev = [int]$e.v.ms }
    }
    $snap = $ph
  }
  return [ordered]@{
    tag = $tag; design = $design; session = $sid; timeoutMs = $timeoutMs
    wallMs = [int]$sw.Elapsed.TotalMilliseconds; isJson = $isJson
    ok = $ok; errCode = $errCode; projectUuid = $projUuid
    phases = $snap
    rawHead = $raw.Substring(0, [Math]::Min(400, $raw.Length))
  }
}

# ---------- 1) 基线：新 session 跑 d8 ----------
$sid0 = New-Session
Log "基线 session = $sid0"
$r1 = Invoke-Design $sid0 'designs\d8-led-8ch.json' "$Tag-baseline" 600000
Log ("基线 d8: wall={0:N1}s isJson={1} ok={2} err={3}" -f ($r1.wallMs/1000), $r1.isJson, $r1.ok, $r1.errCode)
$report.steps += $r1

# ---------- 2) 幽灵：同一 session 用 45s 超时跑 d7（板框按设计 2400x1800） ----------
Log "制造幽灵调用（d7 @2400x1800, timeout=${GhostTimeoutMs}ms）…"
$r2 = Invoke-Design $sid0 'designs\d7-rp2040-flash.json' "$Tag-ghost" $GhostTimeoutMs
Log ("幽灵: wall={0:N1}s isJson={1} err={2}（预期 REQUEST_TIMEOUT，且 render 里仍在跑）" -f ($r2.wallMs/1000), $r2.isJson, $r2.errCode)
$report.steps += $r2

# ---------- 3) 立刻在同一 session 上跑 d8 ----------
Log "立刻在同一 session 上跑 d8（复现 d7→d8 级联）…"
$r3 = Invoke-Design $sid0 'designs\d8-led-8ch.json' "$Tag-poisoned" $ProbeTimeoutMs
Log ("污染后 d8: wall={0:N1}s isJson={1} ok={2} err={3}" -f ($r3.wallMs/1000), $r3.isJson, $r3.ok, $r3.errCode)
$report.steps += $r3
if ($r3.phases) { $r3.phases.GetEnumerator() | ForEach-Object { Write-Host ("    {0,-14} {1,7:N1}s" -f $_.Key, ($_.Value/1000)) } }

# ---------- 4) abort 掉幽灵 + 新 session，再跑 d8 ----------
Log "session abort 杀掉幽灵，重开 session…" 'DarkYellow'
& $CLI session abort --session $sid0 2>&1 | Out-String | ForEach-Object { if ($_) { Write-Host "    abort: $($_.Trim())" -ForegroundColor DarkGray } }
Start-Sleep -Seconds 3
$sid1 = New-Session
Log "新 session = $sid1"
$r4 = Invoke-Design $sid1 'designs\d8-led-8ch.json' "$Tag-recovered" 600000
Log ("恢复后 d8: wall={0:N1}s isJson={1} ok={2} err={3}" -f ($r4.wallMs/1000), $r4.isJson, $r4.ok, $r4.errCode)
$report.steps += $r4

Set-Content -Path (Join-Path $LogDir "diag-$Tag.json") -Encoding UTF8 -Value (ConvertTo-Json $report -Depth 20)
Log ("报告 -> logs\diag-$Tag.json") 'Green'
exit 0
