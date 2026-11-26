$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$script:logs = New-Object System.Collections.ArrayList
function Log($m, $c = 'Cyan') { [void]$script:logs.Add([string]$m) }

$all = Get-Content (Join-Path $Root 'run-all.ps1') -Raw
$s = $all.IndexOf('# ---------- 代码完整性闸门 ----------')
$e0 = $all.IndexOf("throw 'pipeline3.js 与备份都无法通过语法检查")
$e = $all.IndexOf("`n}", $e0) + 2
Invoke-Expression $all.Substring($s, $e - $s)

$tmp = Join-Path $env:TEMP 'tg2'
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $tmp | Out-Null
$good = Join-Path $tmp 'p.js'
Copy-Item (Join-Path $Root 'scripts\pipeline3.js') $good -Force
$scReal = Join-Path $Root 'scripts\staticcheck.js'
$bak = Join-Path $tmp 'sc.bak'
Copy-Item $scReal $bak -Force

function TryGate($label, $want, [scriptblock]$setup) {
  $script:logs.Clear()
  & $setup
  $got = $false
  try { $got = Test-PipelineSyntax $good } catch { $got = $false }
  $mark = if ($got -eq $want) { 'OK' } else { "!! 期望放行=$want 实得=$got" }
  Write-Host ("  {0,-46} 放行={1} {2}" -f $label, $got, $mark)
  $m = ($script:logs | Select-Object -Last 1)
  if ($m) { Write-Host ("       日志: " + $m.Substring(0, [Math]::Min(150, $m.Length))) }
}

Write-Host '=== 契约闸门失败形态 ==='

TryGate 'A 真检查器 + 好文件（应放行）' $true { }

TryGate 'B 检查器自己崩了' $false {
  Set-Content -Path $scReal -Value "throw new Error('ctl: checker crashed');" -Encoding UTF8
}

TryGate 'C 检查器不在（被删）' $false {
  Remove-Item $scReal -Force
}

# 恢复真检查器
Copy-Item $bak $scReal -Force

Write-Host '=== F5：缺陷报文不能被过滤成空串 ==='
$bad = Join-Path $tmp 'bad.js'
$p = [IO.File]::ReadAllText($good)
$i = $p.IndexOf("phase('snapEnds');")
[IO.File]::WriteAllText($bad, $p.Insert($i, "await eda.pcb_PrimitiveLine.delete('x');`n"), (New-Object Text.UTF8Encoding($false)))
$script:logs.Clear()
$got = Test-PipelineSyntax $bad
$msg = ($script:logs | Where-Object { $_ -match '契约检查未通过' })
Write-Host ("  D 有返回值缺陷 -> 放行={0} {1}" -f $got, $(if ($got) { '!! 期望 False' } else { 'OK' }))
Write-Host ("     完整日志: " + $msg)
$body = [string]($msg -replace '(?s).*?契约检查未通过（exit \d+）：', '')
Write-Host ("     报文长度={0} 非空={1}" -f $body.Trim().Length, ($body.Trim().Length -gt 30))

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue