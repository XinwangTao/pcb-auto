# accept-batch.ps1 —— 对已产出的每个产物目录独立复核一遍，汇总成一份可查的判决。
#
# 为什么不复用 run-all.ps1 的结论：那是流水线自己的自述。本脚本调用 accept.ps1，
# 它会重跑三道离线闸门（产物校验 / 可打样 / 设计电气审计）并核对"证据与产物同源"。
#
# 为什么用目录里的 _design.snapshot.json 而不是 designs\*.json：
# snapshot 是 run-all.ps1 在开跑前落盘的那一份，正是构建者当时读到的版本。
# 用当下的 designs\*.json 去核对几分钟前（或几小时前）的产物，会撞上"复核的是另一版设计"。
# 没有 snapshot 的老目录退化为按 _run.json.designName 去 designs\ 里找同名文件，并在结果里标出。
#
# 默认不开 -RecheckDrc：verify-drc.js 会自己拉起 lceda-pro 会话，与无人值守循环并发
# 就变成两个 --owner（那正是把端点打挂的故障）。要真复跑必须等循环退出后单独加开关。
param(
  [switch]$RecheckDrc,
  [string]$Only,          # 只复核目录名包含该子串的
  [int]$Limit = 0,        # 0 = 不限
  [string]$OutFile
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $Root 'accept.ps1'))) { $Root = 'D:\Users\陶鑫旺\Documents\deepseek-harness\default-workspace\pcb-auto' }
$Accept = Join-Path $Root 'accept.ps1'
if (-not $OutFile) { $OutFile = Join-Path $PSScriptRoot '_accept-batch.json' }

# 设计名 -> designs\*.json，用于没有 snapshot 的老目录
$byName = @{}
Get-ChildItem (Join-Path $Root 'designs') -Filter '*.json' | Where-Object { $_.Name -notlike '_*' } | ForEach-Object {
  try {
    $j = Get-Content $_.FullName -Raw | ConvertFrom-Json
    if ($j.name) { $byName[[string]$j.name] = $_.FullName }
  } catch { }
}

$dirs = Get-ChildItem (Join-Path $Root 'out') -Directory |
  Where-Object { $_.Name -notlike '_*' -and (Test-Path (Join-Path $_.FullName '_run.json')) } |
  Sort-Object LastWriteTime
if ($Only) { $dirs = $dirs | Where-Object { $_.Name -like "*$Only*" } }
if ($Limit -gt 0) { $dirs = $dirs | Select-Object -Last $Limit }

Write-Host ("待复核目录 " + $dirs.Count + " 个  RecheckDrc=" + [bool]$RecheckDrc)
$rows = @()
$i = 0
foreach ($d in $dirs) {
  $i++
  $run = $null
  try { $run = Get-Content (Join-Path $d.FullName '_run.json') -Raw | ConvertFrom-Json } catch { }
  $selfOk = if ($run) { [bool]$run.ok } else { $null }

  $snap = Join-Path $d.FullName '_design.snapshot.json'
  $dpath = $null; $src = ''
  if (Test-Path $snap) { $dpath = $snap; $src = 'snapshot' }
  elseif ($run -and $byName.ContainsKey([string]$run.designName)) { $dpath = $byName[[string]$run.designName]; $src = 'designs-by-name' }
  else { $src = 'none' }

  $args = @('-NoProfile', '-File', $Accept, '-VerifyOnly', '-OutDir', $d.FullName)
  if ($dpath) { $args += @('-Design', $dpath) }
  if ($RecheckDrc) { $args += '-RecheckDrc' }

  $raw = (& pwsh @args 2>&1 | Out-String)
  $code = $LASTEXITCODE
  $verd = ''
  $m = [regex]::Match($raw, '(验收通过|验收未通过)')
  if ($m.Success) { $verd = $m.Groups[1].Value }
  $rows += [pscustomobject]@{
    dir = $d.Name; designName = $run.designName; selfOk = $selfOk
    designSrc = $src; exit = $code; verdict = $verd
    mtime = $d.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')
  }
  $mark = if ($code -eq 0) { 'PASS' } else { 'FAIL' }
  Write-Host ("  [{0,3}/{1}] {2}  {3,-42} selfOk={4} src={5}" -f $i, $dirs.Count, $mark, $d.Name, $selfOk, $src)
}

$pass = @($rows | Where-Object { $_.exit -eq 0 }).Count
$fail = @($rows | Where-Object { $_.exit -ne 0 }).Count
$selfPass = @($rows | Where-Object { $_.selfOk -eq $true }).Count
$selfPassButFail = @($rows | Where-Object { $_.selfOk -eq $true -and $_.exit -ne 0 })
Write-Host ''
Write-Host "  独立复核通过 $pass / 未通过 $fail   （自述 ok=true 的共 $selfPass 个）"
if ($selfPassButFail.Count) {
  Write-Host ("  *** 自述 ok=true 但独立复核未通过 " + $selfPassButFail.Count + " 个：")
  $selfPassButFail | ForEach-Object { Write-Host ("        " + $_.dir + "   (" + $_.verdict + ")") }
} else {
  Write-Host "  自述 ok=true 的目录全部通过独立复核（0 个自述漂移）"
}
$rows | ConvertTo-Json -Depth 6 | Set-Content -Path $OutFile -Encoding UTF8
Write-Host ("  判决已写入 " + $OutFile)
