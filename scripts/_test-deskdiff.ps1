# 证明 desktop-diff.ps1 的四个"没测成"路径都归到 exit 2，且不会把相同画面误报成变化。
# 这个测试的价值在于：如果它只会对好样本报 0，那这个量具就是个摆设。
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$Tool = Join-Path $Root 'scripts\desktop-diff.ps1'
$Frames = Join-Path $Root 'out\frames\REAL_143856'
$One = Join-Path $Frames '0010-route-t42s.png'
if (-not (Test-Path $One)) { Write-Host '  缺样本帧，无法测' ; exit 2 }

$tmp = Join-Path $env:TEMP ('ddtest-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

$pass = 0
$fail = 0
function Case([string]$label, [int]$expect, [string[]]$argv, [string]$mustSay) {
  $out = (& pwsh -NoProfile -ExecutionPolicy Bypass -File $Tool @argv 2>&1 | Out-String)
  $code = $LASTEXITCODE
  $okCode = ($code -eq $expect)
  $okSay = $true
  if ($mustSay) { $okSay = $out -match [regex]::Escape($mustSay) }
  if ($okCode -and $okSay) {
    $script:pass++
    Write-Host ('  PASS  ' + $label + '   (exit ' + $code + ')') -ForegroundColor Green
  } else {
    $script:fail++
    Write-Host ('  FAIL  ' + $label + '   expect exit ' + $expect + ' got ' + $code + ' / 含语 "' + $mustSay + '"=' + $okSay) -ForegroundColor Red
  }
}

try {
  # ① 目录不存在 —— 不许安静地报 0 变化
  Case '目录不存在 -> 2' 2 @('-FramesDir', (Join-Path $Root 'out\no-such-dir')) '没能测量'

  # ② 目录存在但一张都不匹配 —— 0 张不是「全部一致」
  Case '一张都不匹配 -> 2' 2 @('-FramesDir', $tmp, '-Pattern', '*.png') '没能测量'

  # ③ 只有 1 张 —— 无法比较，不是「一致」
  Copy-Item $One (Join-Path $tmp 'only.png')
  Case '只有 1 张 -> 2' 2 @('-FramesDir', $tmp, '-Pattern', '*.png') '没能测量'

  # ④ 20 张同一画面的副本，但文件名不同 —— 必须判 FROZEN(1)，
  #    不许因为"文件字节数不同/名字不同"就当成画面在变。
  Remove-Item (Join-Path $tmp '*.png') -Force -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 20; $i++) { Copy-Item $One (Join-Path $tmp ('dup{0:d2}.png' -f $i)) }
  Case '20 张同一画面 -> 1 (FROZEN)' 1 @('-FramesDir', $tmp, '-Pattern', '*.png') 'FROZEN'

  # ⑤ 反向：真实布线帧必须也判 FROZEN（这是原结论的复算）
  Case '真实布线帧 -> 1 (FROZEN)' 1 @('-FramesDir', $Frames, '-Pattern', '*route*.png') 'FROZEN'

  # ⑥ 反向：跨阶段帧必须判 MOVING(0)，否则这个量具恒报冻结
  Case '跨阶段帧 -> 0 (MOVING)' 0 @('-FramesDir', $Frames, '-Pattern', '*pcb-*.png') 'MOVING'

  Write-Host ''
  Write-Host ('  合计 PASS=' + $pass + ' FAIL=' + $fail)
  if ($fail -gt 0) { exit 1 }
  exit 0
}
finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
