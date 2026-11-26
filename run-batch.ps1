# ============================================================
# 批量回归：跑 designs\ 下全部设计，输出汇总表
# 用法： pwsh -NoProfile -File .\run-batch.ps1
#        pwsh -NoProfile -File .\run-batch.ps1 -Pattern 'd[12]*'
# ============================================================
param([string]$Pattern = 'd*.json')
$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
$files = Get-ChildItem (Join-Path $Root 'designs') -Filter $Pattern | Sort-Object Name

if (-not $files) { Write-Host "no design matched $Pattern" -ForegroundColor Yellow; exit 1 }

$rows = @()
$fail = 0
foreach ($f in $files) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $out = (& pwsh -NoProfile -File (Join-Path $Root 'run-all.ps1') -Design "designs\$($f.Name)" 2>&1 | Out-String)
  $sw.Stop()

  $pass = $out -match '通过\s+:\s+True'
  if (-not $pass) { $fail++ }
  $drc    = if ($out -match 'DRC 违规组数\s+:\s+(\d+)') { $Matches[1] } else { '?' }
  $schErr = if ($out -match '原理图 DRC\s+:\s+(\w+)') { $Matches[1] } else { '?' }
  $mis    = if ($out -match '网表不一致\s+:\s+(\d+)') { $Matches[1] } else { '?' }
  $heal   = if ($out -match '自愈策略：([\w.\-]+)') { $Matches[1] } else { '?' }
  $sec    = if ($out -match '耗时\s+:\s+([\d.]+)s') { $Matches[1] } else { '?' }
  $comp   = if ($out -match '器件\s+:\s+(.+)') { ($Matches[1].Trim() -split ',').Count } else { '?' }
  $outDir = if ($out -match '产物目录\s+:\s+(.+)') { $Matches[1].Trim() } else { '' }
  $warns  = ([regex]::Matches($out, '社区上传件')).Count

  $rows += [pscustomobject]@{
    Design = $f.BaseName; Pass = $pass; Comp = $comp; DRC = $drc
    SchDRC = $schErr; Netlist = $mis; Warn = $warns; Sec = $sec; Heal = $heal
  }
  Write-Host ("[{0}] {1}  DRC={2}  {3}s" -f $(if($pass){'PASS'}else{'FAIL'}), $f.BaseName, $drc, $sec) `
    -ForegroundColor $(if($pass){'Green'}else{'Red'})
}

Write-Host ''
Write-Host '================ 批量回归汇总 ================' -ForegroundColor Cyan
$rows | Format-Table -AutoSize | Out-String | Write-Host
Write-Host ("{0} / {1} 通过" -f ($rows.Count - $fail), $rows.Count) `
  -ForegroundColor $(if($fail -eq 0){'Green'}else{'Red'})
Write-Host '==============================================' -ForegroundColor Cyan

exit $(if ($fail -eq 0) { 0 } else { 1 })
