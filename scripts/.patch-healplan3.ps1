# 给 run-all.ps1 的自愈阶梯加第三级：同尺寸重跑。
#
# 依据（实测，不是推测）：同设计 + 同板框 + 同一 plan(smart-fit) 的**独立运行**结果不一致：
#   AI_RP2040_系统_15pqy38  6 通过 / 2 失败
#   Crystal_RTC_Clock       1 通过 / 2 失败
#   RP2040_Minimal          1 通过 / 1 失败
#   USBC_Power_ESD          1 通过 / 2 失败
# 说明布线是非确定性的。所以"两级都失败"只等于"这两次骰子不好"。
#
# 为什么不扩板：扩板对 DRC 零收益已被实测否定（d6/d7/d11/d12 在 1.5x/2.0x 上重复同样失败）。
# 这里要换的是布线骰子，不是板子大小，所以沿用 expand-1.25x 的尺寸（它有最大的布线余地，
# SHT30 系列正是靠它才通过）。
#
# 代价：只对"两级都失败"的设计多跑一次 invoke。第三级被放在最后，任何一次通过都在 L898 的
# break 处收工，所以通过的设计不受影响。
#
# 安全性论证（为什么同尺寸方案能被采纳）：采纳条件是
#   if ($null -eq $bestRaw -or $curArea -lt $bestArea)
# 同尺寸时 $curArea -lt $bestArea 为假，但只有**前面已经采纳过**才会这样；而前面能采纳就意味着
# 已经在 L898 break 了。所以走到第三级时 $bestRaw 必为 $null，走第一个分支被采纳。
#
# 本脚本只生成 run-all.ps1.next 并校验，不动正式文件。atomic move 单独做。
$ErrorActionPreference = 'Stop'
$Root = 'D:\Users\陶鑫旺\Documents\deepseek-harness\default-workspace\pcb-auto'
$Target = Join-Path $Root 'run-all.ps1'
$Next   = Join-Path $Root 'run-all.ps1.next'

$lines = [IO.File]::ReadAllLines($Target)
$old = $lines.Count
Write-Host "  读入 $old 行"

# 锚点用**整行正则**匹配，不用子串：实测该行前导是 2 空格（不是 4），
# 子串锚点写错会静默返回 -1，而整行正则 + 计数断言会当场失败。
$pat = '^\s*@\{\s*w = \$baseW \* 1\.25;\s*h = \$baseH \* 1\.25;\s*tag = ''expand-1\.25x''\s*\}\s*$'
$hits = @()
for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match $pat) { $hits += $i } }
if ($hits.Count -ne 1) { Write-Host "  x 锚点命中 $($hits.Count) 次（必须恰好 1 次），不改" -ForegroundColor Red; exit 3 }
$at = $hits[0]
Write-Host "  锚点在 L$($at + 1)"

if ($lines[$at + 1] -notmatch '^\s*\)\s*$') {
  Write-Host "  x L$($at + 2) 不是收尾括号，结构不符合预期，不改" -ForegroundColor Red
  exit 4
}

$ins = @(
  '  # 第三次尝试：**同尺寸重跑**（2026-11-26 02:1x 加）。',
  '  # 依据是实测的非确定性：同一设计、同一板框、同一 smart-fit 的独立运行结果不一致 ——',
  '  # AI_RP2040_系统 6 通过/2 失败，Crystal_RTC_Clock 1/2，RP2040_Minimal 1/1，USBC 1/2。',
  '  # 所以"两级都失败"不等于"这块板布不出来"，只等于"这两次骰子不好"。',
  '  # 沿用同尺寸而不是再扩板：扩板对 DRC 零收益已被 d6/d7/d11/d12 在 1.5x/2.0x 上反复否定。',
  '  # 通过的设计不受影响 —— 任何一次通过都在循环末尾 break，走不到这一级。',
  '  @{ w = $baseW * 1.25; h = $baseH * 1.25; tag = ''expand-1.25x-retry'' }'
)

$out = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $lines.Count; $i++) {
  $out.Add($lines[$i])
  if ($i -eq $at) { foreach ($x in $ins) { $out.Add($x) } }
}

$enc = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllLines($Next, $out, $enc)
Write-Host "  写出 $($out.Count) 行（+$($ins.Count)）→ run-all.ps1.next"

# ---- 校验 1：PowerShell 语法必须 0 错误
$tokens = $null; $errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($Next, [ref]$tokens, [ref]$errors)
if ($errors -and $errors.Count -gt 0) {
  Write-Host "  x 解析错误 $($errors.Count) 个:" -ForegroundColor Red
  $errors | Select-Object -First 5 | ForEach-Object { Write-Host "      $($_.Extent.StartLineNumber): $($_.Message)" }
  exit 5
}
Write-Host "  OK 解析 0 错误（token $($tokens.Count)）"

# ---- 校验 2：行尾必须仍是 CRLF（写回时若混入裸 LF，PowerShell 仍能解析，但 diff 会变成整文件）
$nb = [IO.File]::ReadAllBytes($Next)
$crlf = 0; $lf = 0
for ($i = 0; $i -lt $nb.Length; $i++) {
  if ($nb[$i] -eq 10) { if ($i -gt 0 -and $nb[$i - 1] -eq 13) { $crlf++ } else { $lf++ } }
}
Write-Host "  CRLF=$crlf 裸LF=$lf"
if ($lf -ne 0) { Write-Host "  x 出现裸 LF" -ForegroundColor Red; exit 6 }
if ($crlf -ne $out.Count) { Write-Host "  x CRLF 数($crlf) ≠ 行数($($out.Count))" -ForegroundColor Red; exit 7 }

# ---- 校验 3：结构不变量 —— 阶梯必须恰好 3 级，且顺序为 smart-fit → expand → retry
$newLines = [IO.File]::ReadAllLines($Next)
$tags = @()
foreach ($l in $newLines) { if ($l -match "tag = '(?<t>[^']+)'") { $tags += $Matches['t'] } }
Write-Host "  阶梯: $($tags -join ' → ')"
if ($tags.Count -ne 3) { Write-Host "  x 阶梯不是 3 级" -ForegroundColor Red; exit 8 }
if ($tags[0] -ne 'smart-fit' -or $tags[1] -ne 'expand-1.25x' -or $tags[2] -ne 'expand-1.25x-retry') {
  Write-Host "  x 阶梯顺序或名字不对" -ForegroundColor Red; exit 9
}

# ---- 校验 4：L898 的 break 必须还在（否则通过后还会继续跑更大的板框，纯浪费）
if (-not ($newLines -contains '    break')) { Write-Host "  x 找不到收尾 break" -ForegroundColor Red; exit 10 }
$breakIdx = -1
for ($i = 0; $i -lt $newLines.Count; $i++) { if ($newLines[$i] -eq '    break' -and $i -gt 880) { $breakIdx = $i + 1; break } }
Write-Host "  收尾 break 在 L$breakIdx"
if ($breakIdx -lt 0) { Write-Host "  x 收尾 break 位置异常" -ForegroundColor Red; exit 11 }

Write-Host "  CANDIDATE_OK  $($nb.Length) B" -ForegroundColor Green
exit 0
