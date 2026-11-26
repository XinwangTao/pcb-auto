# 给 run-all.ps1 的失败分支加"违规类型"输出，让 fail-*.txt 自带判据。
#
# 动机：失败报告原来只有一行「未通过：DRC 违规组 1」，我每次都得再翻 _log.json 才知道是
# 哪一类违规（d12 是 SMD Pad to Track，d13 是 Slot Region to Track）。这类取证重复了十几次。
# run-overnight.ps1 L238 把 run-all 的标准输出整体落成 fail-*.txt，所以打在标准输出上就够。
#
# 【必须防陈旧读数】invoke 超时返回时 $OutDir\_log.json 可能还是上一次尝试写的。
# 若不加判断，会把上一轮的类型当成这一轮的证据 —— 这就是"陈旧证据"错误。
# 判法：拿 $v.elapsedMs 当参照，文件比本次运行时长还老 30s 以上就标"陈旧"并注明，不静默采信。
#
# 本脚本只生成 run-all.ps1.next 并校验。
$ErrorActionPreference = 'Stop'
$Root = 'D:\Users\陶鑫旺\Documents\deepseek-harness\default-workspace\pcb-auto'
$Target = Join-Path $Root 'run-all.ps1'
$Next   = Join-Path $Root 'run-all.ps1.next'

$lines = [IO.File]::ReadAllLines($Target)
Write-Host "  读入 $($lines.Count) 行"

# 锚点整行匹配（前导 4 空格），前后行也断言，避免插到错的分支里
$pat = '^\s{4}Log \("\[\$\(\$plan\.tag\)\] 未通过：DRC 违规组 \$\(\$v\.drcDetailCount\)"\) ''Yellow''\s*$'
$hits = @()
for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match $pat) { $hits += $i } }
if ($hits.Count -ne 1) { Write-Host "  x 锚点命中 $($hits.Count) 次（必须恰好 1 次），不改" -ForegroundColor Red; exit 3 }
$at = $hits[0]
Write-Host "  锚点在 L$($at + 1)"
if ($lines[$at + 1] -notmatch '^\s{4}continue\s*$') {
  Write-Host "  x 下一行不是 continue，结构不符合预期，不改" -ForegroundColor Red
  exit 4
}

$ins = @(
  '    # 【失败报告要自带判据】原来只写"DRC 违规组 N"，得再翻 _log.json 才知道是哪类违规。',
  '    # 实测这让我反复做同一次取证（d12 是 SMD Pad to Track，d13 是 Slot Region to Track）。',
  '    # 【必须防陈旧读数】invoke 超时返回时 _log.json 可能还是上一次尝试写的，',
  '    # 直接采信就会把旧类型当成这一轮的证据。用 $v.elapsedMs 当参照，陈旧就明说。',
  '    $logPath = Join-Path $OutDir ''_log.json''',
  '    if (Test-Path $logPath) {',
  '      try {',
  '        $ageS = [int]((Get-Date) - (Get-Item $logPath).LastWriteTime).TotalSeconds',
  '        $runS = 0',
  '        if ($null -ne $v -and $null -ne $v.elapsedMs) { $runS = [int]([double]$v.elapsedMs / 1000) }',
  '        $staleTag = ''''',
  '        if ($ageS -gt ($runS + 30)) { $staleTag = " 【陈旧：写于 $ageS s 前，本次只跑了 $runS s，可能是上一次尝试留下的】" }',
  '        $lj = Get-Content $logPath -Raw | ConvertFrom-Json',
  '        $dl = @($lj.entries | Where-Object { $_.s -eq ''drcLeaves'' }) | Select-Object -Last 1',
  '        if ($null -ne $dl -and $null -ne $dl.v -and $null -ne $dl.v.byType) {',
  '          $desc = (@($dl.v.byType.PSObject.Properties) | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ''; ''',
  '          Log ("    违规类型" + $staleTag + ": " + $desc) ''DarkYellow''',
  '        } else {',
  '          Log ("    无违规类型明细（_log.json 里没有 drcLeaves）" + $staleTag) ''DarkYellow''',
  '        }',
  '      } catch { Log ("    读 _log.json 失败：" + $_.Exception.Message) ''DarkYellow'' }',
  '    } else { Log "    无 _log.json，无法给出违规类型" ''DarkYellow'' }'
)

$out = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $lines.Count; $i++) {
  $out.Add($lines[$i])
  if ($i -eq $at) { foreach ($x in $ins) { $out.Add($x) } }
}

$enc = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllLines($Next, $out, $enc)
Write-Host "  写出 $($out.Count) 行（+$($ins.Count)）"

# 校验 1：解析 0 错误
$tok=$null; $err=$null
[void][System.Management.Automation.Language.Parser]::ParseFile($Next, [ref]$tok, [ref]$err)
if ($err -and $err.Count -gt 0) {
  Write-Host "  x 解析错误 $($err.Count):" -ForegroundColor Red
  $err | Select-Object -First 5 | ForEach-Object { Write-Host "      L$($_.Extent.StartLineNumber): $($_.Message)" }
  exit 5
}
Write-Host "  OK 解析 0 错误"

# 校验 2：行尾与不变量
$nb = [IO.File]::ReadAllBytes($Next)
$crlf=0; $lf=0
for ($i=0; $i -lt $nb.Length; $i++) { if ($nb[$i] -eq 10) { if ($i -gt 0 -and $nb[$i-1] -eq 13) { $crlf++ } else { $lf++ } } }
Write-Host "  CRLF=$crlf 裸LF=$lf"
if ($lf -ne 0 -or $crlf -ne $out.Count) { Write-Host "  x 行尾不符" -ForegroundColor Red; exit 6 }

$nl = [IO.File]::ReadAllLines($Next)
$tags = @(); foreach ($l in $nl) { if ($l -match "tag = '(?<x>[^']+)'") { $tags += $Matches['x'] } }
Write-Host "  阶梯仍是: $($tags -join ' -> ')"
if ($tags.Count -ne 3) { Write-Host "  x 阶梯被破坏" -ForegroundColor Red; exit 7 }
if (-not ($nl -contains '    break')) { Write-Host "  x 收尾 break 丢了" -ForegroundColor Red; exit 8 }

# 校验 3：新增块必须真在 if (-not $v.ok) 分支内，且陈旧标记与非静默兜底都在
$txt = $nl -join "`n"
foreach ($need in @('$staleTag = " 【陈旧', "Where-Object { `$_.s -eq 'drcLeaves' }", '读 _log.json 失败', '无 _log.json，无法给出违规类型')) {
  if ($txt.IndexOf($need) -lt 0) { Write-Host "  x 缺少关键片段：$need" -ForegroundColor Red; exit 9 }
}
$iAnchor = -1; $iCont = -1
for ($i=0; $i -lt $nl.Count; $i++) {
  if ($nl[$i] -match 'DRC 违规组 \$\(\$v\.drcDetailCount\)') { $iAnchor = $i }
  if ($iAnchor -ge 0 -and $nl[$i] -match '^\s{4}continue\s*$' -and $i -gt $iAnchor) { $iCont = $i; break }
}
if ($iAnchor -lt 0 -or $iCont -lt 0) { Write-Host "  x 定位失败" -ForegroundColor Red; exit 10 }
Write-Host "  新块在 L$($iAnchor+2)..L$($iCont)（continue 在 L$($iCont+1)）"

Write-Host "  CANDIDATE_OK $($nb.Length) B" -ForegroundColor Green
exit 0
