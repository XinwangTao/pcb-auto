# 全量回归：逐个设计跑 run-all.ps1，记录结果。
# 用途：验证 12 个设计在真实操作下的通过率，找出仍不稳的设计。
param(
  [string]$OutLog = 'out\regress.log',
  [string[]]$Only = @()
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$designs = if ($Only.Count -gt 0) {
  $Only
} else {
  Get-ChildItem designs\d*.json | Where-Object { $_.BaseName -notlike '_*' } | Sort-Object Name | ForEach-Object { $_.FullName }
}

"=== 回归开始 $(Get-Date -Format 'HH:mm:ss') 共 $($designs.Count) 个设计 ===" | Tee-Object -FilePath $OutLog

$pass = 0; $fail = 0; $results = @()
foreach ($d in $designs) {
  $name = [System.IO.Path]::GetFileNameWithoutExtension($d)
  "`n--- [$name] $(Get-Date -Format 'HH:mm:ss') ---" | Tee-Object -FilePath $OutLog -Append
  $t0 = Get-Date
  $raw = & pwsh -NoProfile -File run-all.ps1 -Design $d 2>&1 | Out-String
  $sec = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
  $raw | Tee-Object -FilePath $OutLog -Append | Out-Null

  # 判定只看 run-all 的结果块，不能用"未通过"这类词做全文匹配 ——
  # 自愈过程里会出现「紧凑板框流水线未通过，保留原方案」这种**正常**日志，
  # 全文匹配会把成功的设计误判成失败（实测 d5/d6/d10/d12 全被误判）。
  # 只认结果块里的结构化字段，不看散文。
  $ok = $false
  if ($raw -match '通过\s*:\s*True') { $ok = $true }
  if ($raw -match 'PCB DRC 通过\s*:\s*False') { $ok = $false }
  # 独立校验的汇总行：无失败才算过（备注不算失败）
  if ($raw -match '结果:\s*[^\r\n]*?（\s*\d+ 通过\s*/\s*0 失败') { $ok = $true }
  if ($raw -match '结果:\s*[^\r\n]*?（\s*\d+ 通过\s*/\s*[1-9]\d* 失败') { $ok = $false }

  if ($ok) { $pass++ } else { $fail++ }
  $results += [pscustomobject]@{ Design = $name; Pass = $ok; Sec = $sec }
  $mark = if ($ok) { 'PASS' } else { 'FAIL' }
  "[$name] $mark ${sec}s" | Tee-Object -FilePath $OutLog -Append
}

"" | Tee-Object -FilePath $OutLog -Append
"=== 汇总 $(Get-Date -Format 'HH:mm:ss') ===" | Tee-Object -FilePath $OutLog -Append
"通过 $pass / $($designs.Count)，失败 $fail" | Tee-Object -FilePath $OutLog -Append
$results | ForEach-Object {
  $mark = if ($_.Pass) { 'PASS' } else { 'FAIL' }
  "  {0,-22} {1,-5} {2,7}s" -f $_.Design, $mark, $_.Sec
} | Tee-Object -FilePath $OutLog -Append
