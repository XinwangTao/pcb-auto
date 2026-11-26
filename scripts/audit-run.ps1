# ============================================================
# audit-run.ps1 — 批量独立只读复核（PCB DRC）
# 用法：
#   .\scripts\audit-run.ps1                       # 跑 audit-cases.json 全部
#   .\scripts\audit-run.ps1 -Only d6,d7,d11,d12   # 只跑指定几个
#   .\scripts\audit-run.ps1 -Session <sid>        # 复用已有 headless session
# 输出：scripts\audit-results.json（每个 case 一条，含两遍 DRC 明细）
# 只读：不 save、不 modify、不 create、不 delete 任何工程对象。
# ============================================================
param(
  [string]$Cases = (Join-Path $PSScriptRoot 'audit-cases.json'),
  [string]$Out   = (Join-Path $PSScriptRoot 'audit-results.json'),
  [string[]]$Only = @(),
  [string]$Session = ''
)
$ErrorActionPreference = 'Stop'
$CLI = 'E:\APP\lceda-pro\lceda-pro.exe'
$Root = Split-Path $PSScriptRoot -Parent
$SessionFile = Join-Path $PSScriptRoot '.audit-session'
$CodeFile = Join-Path $PSScriptRoot 'audit-drc.js'

function Log($m, $c = 'Cyan') { Write-Host "[audit] $m" -ForegroundColor $c }

# ---- session：独立于流水线的 .session，绝不占用 run-all 的那个 ----
if (-not $Session) {
  if (Test-Path $SessionFile) {
    $cand = (Get-Content $SessionFile -Raw).Trim()
    $probe = (& $CLI invoke --session $cand --ext-uuid eda --code 'return 1' --timeout 30000 2>&1 | Out-String)
    try { if (($probe | ConvertFrom-Json).ok) { $Session = $cand } } catch { }
  }
  if (-not $Session) {
    Log '启动独立 headless session…'
    $open = (& $CLI open --headless true 2>&1 | Out-String)
    $Session = ($open | ConvertFrom-Json).value.sessionId
    if (-not $Session) { throw "open failed: $open" }
    Set-Content -Path $SessionFile -Value $Session -NoNewline
  }
}
Log "session = $Session"

$all = Get-Content $Cases -Raw | ConvertFrom-Json
$todo = if ($Only.Count) { @($all | Where-Object { $Only -contains $_.id }) } else { @($all) }
Log ("待复核 {0} 个工程" -f $todo.Count)

$results = @()
foreach ($c in $todo) {
  $t0 = Get-Date
  Log ("---- {0} {1} ----" -f $c.id, $c.design) 'DarkGray'
  Log ("uuid={0}" -f $c.uuid) 'DarkGray'
  $row = [ordered]@{
    id = $c.id; design = $c.design; designFile = $c.designFile; outDir = $c.outDir
    uuid = $c.uuid; declared = $c.declared
    pipeline = [ordered]@{ drcPassed = $c.selfDrc; drcDetailCount = $c.selfGroups; heal = $c.heal }
  }
  $raw = $null; $val = $null
  for ($try = 1; $try -le 2; $try++) {
    try {
      $raw = (& $CLI invoke --session $Session --ext-uuid eda --code-file $CodeFile --args (@{ uuid = $c.uuid } | ConvertTo-Json -Compress) --timeout 300000 2>&1 | Out-String)
    } catch { Log ("invoke 异常：{0}" -f $_.Exception.Message) 'Yellow'; $raw = $null }
    if ($raw) {
      $env2 = $null
      try { $env2 = $raw | ConvertFrom-Json } catch { $env2 = $null }
      if ($env2 -and $env2.ok -and $env2.value) { $val = $env2.value; break }
      if ($raw -match 'SESSION_NOT_FOUND|does not exist') {
        Log 'session 失效，重建' 'Yellow'
        Remove-Item $SessionFile -Force -ErrorAction SilentlyContinue
        $open = (& $CLI open --headless true 2>&1 | Out-String)
        $Session = ($open | ConvertFrom-Json).value.sessionId
        Set-Content -Path $SessionFile -Value $Session -NoNewline
        continue
      }
      Log ("返回非预期：{0}" -f $raw.Substring(0, [Math]::Min(300, $raw.Length))) 'Yellow'
    }
    Start-Sleep -Seconds 3
  }
  $row.audit = $val
  $row.auditMs = [int]((Get-Date) - $t0).TotalMilliseconds
  if (-not $val) { Log ("{0} 复核失败（无结果）" -f $c.id) 'Red' }
  else {
    Log ("{0} before={1} after={2} 违规={3} 板框={4}x{5} 填充率={6}" -f `
      $c.id, $val.passedBefore, $val.passedAfter, `
      $(if ($val.after) { $val.after.total } else { '?' }), `
      $(if ($val.outline) { $val.outline.w } else { '?' }), `
      $(if ($val.outline) { $val.outline.h } else { '?' }), `
      $(if ($null -ne $val.fillRatio) { $val.fillRatio } else { '?' })) `
      $(if ($val.passed) { 'Green' } else { 'Red' })
  }
  $results += [pscustomobject]$row
  # 增量落盘，长跑中断也不丢数据
  $results | ConvertTo-Json -Depth 20 | Set-Content -Path $Out -Encoding UTF8
}
Log ("完成：{0} 条 → {1}" -f $results.Count, $Out) 'Green'
