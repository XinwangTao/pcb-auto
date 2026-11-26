# d7d8-verify.ps1 —— 用**补丁后的副本**验证两件事（原文件一行不改）
#
#  T1 形状修复：d7 按新预估公式算出的板框 1130x1130 跑通（旧公式给 2400x1800 → 失败）
#  T2 预算闸门：把 budgetMs 压到 100s、外部 --timeout 压到 150s，流水线必须
#     **自己收尾并返回合法 JSON**，而不是被外部掐断留下幽灵调用（这就是 d7 超时的根因）
#
# 产出 logs\diag-verify.json
param(
  # 【默认值曾经指向一份死代码】旧默认是 scripts\.patchwork\pipeline3.patched.js
  # （66,618 B / 1,379 行，11-25 18:42 的一次性补丁快照）；而现版 scripts\pipeline3.js
  # 已长到 226,071 B / 3,827 行。那份补丁早已并入现版、快照再没更新过，
  # 于是"跑一遍 d7d8-verify 通过"描述的是**三分之一的旧代码**，结论不能外推到现版。
  # 默认改为现版；仍允许用 -CodeFile 指定副本（T1/T2 的原始用途），
  # 但下面会强制记下它是不是现版，避免结果被错误归因。
  [string]$CodeFile = 'scripts\pipeline3.js',
  [string]$Design = 'designs\d7-rp2040-flash.json',
  [string]$Tag = 'verify',
  [int]$W = 1130,
  [int]$H = 1130,
  [int]$BudgetT1 = 530000,
  [int]$TimeoutT1 = 590000,
  [int]$BudgetT2 = 100000,
  [int]$TimeoutT2 = 150000,
  [switch]$SkipT2
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

# ---------- 陈旧度守卫：结论只对"被测的那份代码"成立 ----------
# 动机：这份脚本的默认值曾长期指向 .patchwork 里的一次性快照（1,379 行），
# 而现版已是 3,827 行。脚本照跑、照出 diag-verify.json、照"通过"，
# 但没有任何字段能告诉后来人"这不是现版"。属性归因错了，比脚本坏掉更危险。
# 做法：不阻止运行（T1/T2 本来就要验副本），但把实测证据写进结果与屏幕。
$LivePipeline = Join-Path $Root 'scripts\pipeline3.js'
$CodePath = if ([IO.Path]::IsPathRooted($CodeFile)) { $CodeFile } else { Join-Path $Root $CodeFile }
$codeInfo = [ordered]@{
  path        = $CodePath
  exists      = $false
  bytes       = 0
  lines       = 0
  sha12       = ''
  liveBytes   = 0
  liveLines   = 0
  liveSha12   = ''
  isLive      = $false
  ratioToLive = 0
  note        = ''
}
if (Test-Path -LiteralPath $CodePath) {
  $codeInfo.exists = $true
  $codeInfo.bytes = (Get-Item -LiteralPath $CodePath).Length
  $codeInfo.sha12 = (Get-FileHash -LiteralPath $CodePath -Algorithm SHA256).Hash.Substring(0, 12).ToLower()
  $codeInfo.lines = ([IO.File]::ReadAllLines($CodePath)).Count
}
if (Test-Path -LiteralPath $LivePipeline) {
  $codeInfo.liveBytes = (Get-Item -LiteralPath $LivePipeline).Length
  $codeInfo.liveSha12 = (Get-FileHash -LiteralPath $LivePipeline -Algorithm SHA256).Hash.Substring(0, 12).ToLower()
  $codeInfo.liveLines = ([IO.File]::ReadAllLines($LivePipeline)).Count
}
if (-not $codeInfo.exists) {
  $codeInfo.note = '被测代码不存在，T1/T2 不可能有效'
} elseif ($codeInfo.sha12 -eq $codeInfo.liveSha12) {
  $codeInfo.isLive = $true
  $codeInfo.ratioToLive = 1
  $codeInfo.note = '被测代码就是现版 pipeline3.js，结论可归因到现版'
} elseif ($codeInfo.liveBytes -gt 0) {
  # 用「行数比」而不是字节比：补丁副本与正文字节构成相同，行数更能反映规模差距
  $codeInfo.ratioToLive = [math]::Round($codeInfo.lines / [math]::Max(1, $codeInfo.liveLines), 3)
  if ($codeInfo.ratioToLive -lt 0.9) {
    $codeInfo.note = "被测代码只有现版的 $([math]::Round($codeInfo.ratioToLive * 100))% 行数（" +
      "$($codeInfo.lines) vs $($codeInfo.liveLines) 行）—— 结论**不可**归因到现版 pipeline3.js，必须在报告里写明"
    Write-Host ("  ! 陈旧代码：$($codeInfo.lines) 行 / 现版 $($codeInfo.liveLines) 行") -ForegroundColor Yellow
  } else {
    $codeInfo.note = "被测代码与现版同量级但 sha 不同（$($codeInfo.sha12) vs $($codeInfo.liveSha12)），结论仍须标注被测 sha"
  }
}
Write-Host ("  被测代码: " + $codeInfo.sha12 + "  " + $codeInfo.lines + " 行  现版: " + $codeInfo.liveSha12 + "  " + $codeInfo.liveLines + " 行") -ForegroundColor DarkGray
if (-not $codeInfo.isLive -and $codeInfo.note) { Write-Host ("  " + $codeInfo.note) -ForegroundColor Yellow }
$CLI = 'E:\APP\lceda-pro\lceda-pro.exe'
$LogDir = Join-Path $Root 'logs'
$OutRoot = Join-Path $Root 'diag-out'
$Code = [IO.Path]::GetFullPath((Join-Path $Root $CodeFile))
if (-not (Test-Path $Code)) { throw "找不到补丁文件：$Code" }
$rep = [ordered]@{ codeFile = $CodeFile; board = "$W x $H mil"; cases = @() }
# 把「测的是哪份代码」写进报告本身：屏幕上的黄字会随终端滚掉，JSON 不会。
$rep.codeInfo = $codeInfo

function Log($m, $c = 'Cyan') { Write-Host "[verify] $m" -ForegroundColor $c }
function New-Session {
  $o = (& $CLI open --headless true 2>&1 | Out-String)
  $sid = ($o | ConvertFrom-Json).value.sessionId
  if (-not $sid) { throw "open 失败: $o" }
  return $sid
}

function Run-Case([string]$tag, [string]$design, [int]$w, [int]$h, [int]$budgetMs, [int]$timeoutMs) {
  $sid = New-Session
  Log "案例 $tag：session=$sid 板框 ${w}x${h} budget=${budgetMs}ms timeout=${timeoutMs}ms"
  $outDir = [IO.Path]::GetFullPath((Join-Path $OutRoot "verify-$tag"))
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  $d = Get-Content (Join-Path $Root $design) -Raw | ConvertFrom-Json
  $d.boardWidthMil = $w; $d.boardHeightMil = $h
  $argsFile = Join-Path $Root "scripts\d7d8-args-verify-$tag.json"
  Set-Content -Path $argsFile -Encoding UTF8 -Value (ConvertTo-Json -Compress -Depth 20 @{ design = $d; outDir = $outDir; budgetMs = $budgetMs })
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $raw = (& $CLI invoke --session $sid --ext-uuid eda --code-file $Code --args (Get-Content $argsFile -Raw) --timeout $timeoutMs 2>&1 | Out-String)
  $sw.Stop()
  $env = $null
  try { $env = $raw | ConvertFrom-Json } catch { }
  $v = if ($env) { $env.value } else { $null }
  $isJson = [bool]$env
  $timeoutHit = $raw -match 'REQUEST_TIMEOUT'
  $errCode = if ($env -and $env.error) { $env.error.code } elseif (-not $env) { 'NON_JSON' } else { '' }
  # 阶段耗时 + 预算相关日志
  $phases = [ordered]@{}
  $budgetLogs = @()
  if ($v) {
    $prev = 0
    foreach ($e in @($v.log)) {
      if ($e.s -eq 'PHASE') { $phases[$e.v.n] = [math]::Round(([int]$e.v.ms - $prev) / 1000, 1); $prev = [int]$e.v.ms }
      elseif ($e.s -match 'budget|Budget|Skipped|snappedLines') { $budgetLogs += (ConvertTo-Json -Compress -Depth 5 $e) }
    }
  }
  Log ("  -> wall={0:N1}s isJson={1} ok={2} timeoutHit={3} err={4}" -f ($sw.Elapsed.TotalSeconds), $isJson, $(if ($v) { $v.ok } else { $null }), $timeoutHit, $errCode) `
      $(if ($isJson -and $v.ok) { 'Green' } elseif ($isJson) { 'Yellow' } else { 'Red' })
  if ($phases.Count) { $phases.GetEnumerator() | ForEach-Object { Write-Host ("     {0,-14} {1,7:N1}s" -f $_.Key, $_.Value) } }
  $budgetLogs | ForEach-Object { Write-Host "     log: $_" -ForegroundColor DarkGray }
  try { & $CLI session abort --session $sid 2>&1 | Out-Null } catch { }
  return [ordered]@{
    tag = $tag; design = $design; session = $sid; boardMil = @($w, $h)
    budgetMs = $budgetMs; timeoutMs = $timeoutMs
    wallMs = [int]$sw.Elapsed.TotalMilliseconds; isJson = $isJson; timeoutHit = $timeoutHit
    ok = $(if ($v) { $v.ok } else { $null }); errCode = $errCode
    drcPassed = $(if ($v) { $v.drcPassed } else { $null })
    drcDetailCount = $(if ($v) { $v.drcDetailCount } else { $null })
    outlineFillRatio = $(if ($v) { $v.outlineFillRatio } else { $null })
    phases = $phases; budgetLogs = $budgetLogs
  }
}

$rep.cases += (Run-Case 'T1-shape' $Design $W $H $BudgetT1 $TimeoutT1)
if (-not $SkipT2) { $rep.cases += (Run-Case 'T2-budget' $Design $W $H $BudgetT2 $TimeoutT2) }

Set-Content -Path (Join-Path $LogDir "diag-$Tag.json") -Encoding UTF8 -Value (ConvertTo-Json $rep -Depth 20)
Log "报告 -> logs\diag-$Tag.json" 'Green'
$bad = @($rep.cases | Where-Object { -not $_.isJson -or $_.timeoutHit })
if ($bad.Count) { Log ("失败案例：{0}" -f (($bad | ForEach-Object { $_.tag }) -join ',')) 'Red'; exit 1 }
Log 'T1/T2 均返回合法 JSON，无外部超时' 'Green'
exit 0
