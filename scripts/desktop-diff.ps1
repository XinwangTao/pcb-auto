<#
.SYNOPSIS
  帧间变化量具：判定一组画面帧里到底有多少帧真的变了。

.DESCRIPTION
  这个工具存在的唯一理由：项目里最关键的一个结论曾经**无法复算**。
  结论是「自动布线期间画布是冻结的」——依据是 out\frames\REAL_143856 里
  route-*.png 两两差分 <= 0.02。当时那个数字是用一次性 python 脚本算的，
  脚本没留下、口径没写清、别人无法重跑。一个只有我一个人能复算的数字，
  在证据等级上等于口述。

  所以这里把口径固定下来：
    · 灰度化后**缩放到固定的 160x120** 再比 —— 不同截取区域的帧尺寸不同，
      直接比像素会抛 "operands could not be broadcast"（踩过），
      或者更糟：靠长度相同的巧合比出个数字来。
    · 变化量 = 平均绝对灰度差 / 255，落在 [0,1]，与缩放无关、与文件大小无关。
    · **绝不比文件字节数**。实测同一批帧里 219086 字节出现 9 次、
      218829 出现 4 次；长度相同不等于内容相同，反之亦然。
      PNG 压缩抖动会让长度差几个字节而画面完全一样。

  退出码（与 test/ 下三个闸门同一契约）：
    0 = 测到了，且变化帧占比 >= -MinChangedRatio
    1 = **发现了**死画面段（变化帧占比低于阈值）
    2 = 环境问题：目录不存在 / 一张都没匹配到 / 少于 2 帧 / 解码失败
        —— 「没测成」必须归 2，绝不能折成 0 或 1。
        折成 0 是「没检却报通过」，折成 1 是把环境缺陷报成对被测对象的判决。

.PARAMETER FramesDir
  帧目录。与 -Pattern 配合使用。

.PARAMETER Pattern
  文件名通配符，默认 *.png。

.PARAMETER Follow
  连拍模式：对 -Hwnd 指定的窗口（或 -Region）连续抓 N 帧再比较。
  用于判定「桌面上那块区域到底动没动」，这是画布帧拍不到布线过程的替代证据。

.PARAMETER Hwnd
  窗口句柄。缺省时用 -Region 或整个主屏。

.PARAMETER Region
  形如 "x,y,w,h" 的屏幕区域（物理像素）。

.PARAMETER IntervalMs / -Count
  连拍间隔与张数，默认 500ms × 20 张。

.PARAMETER MinChangedRatio
  变化帧占比阈值，默认 0.5。

.PARAMETER Json
  只输出 JSON（便于被别的脚本消费）。诊断信息仍走 stderr。

.EXAMPLE
  # 复算「布线段落是冻结的」这个结论（预期 exit 1）
  .\scripts\desktop-diff.ps1 -FramesDir out\frames\REAL_143856 -Pattern 'route-*.png'

.EXAMPLE
  # 跨阶段帧应当有明显变化（预期 exit 0）
  .\scripts\desktop-diff.ps1 -FramesDir out\frames\REAL_143856 -Pattern 'pcb-*.png'

.EXAMPLE
  # 连拍桌面，看 EDA 窗口在布线期间到底动没动
  .\scripts\desktop-diff.ps1 -Follow -Hwnd 26480036 -IntervalMs 1000 -Count 30
#>
[CmdletBinding(DefaultParameterSetName = 'Dir')]
param(
  [Parameter(ParameterSetName = 'Dir', Position = 0)]
  [string]$FramesDir,

  [Parameter(ParameterSetName = 'Dir')]
  [string]$Pattern = '*.png',

  [Parameter(ParameterSetName = 'Follow')]
  [switch]$Follow,

  [Parameter(ParameterSetName = 'Follow')]
  [long]$Hwnd = 0,

  [Parameter(ParameterSetName = 'Follow')]
  [string]$Region,

  [int]$IntervalMs = 500,
  [int]$Count = 20,
  [double]$MinChangedRatio = 0.5,
  [switch]$Json,
  # 缩放后的比较尺寸。固定住是为了让不同来源的帧可以互相比。
  [int]$CmpWidth = 160,
  [int]$CmpHeight = 120
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:Notes = New-Object System.Collections.ArrayList
function Note([string]$m) { [void]$script:Notes.Add($m); if (-not $Json) { Write-Host ('  ' + $m) -ForegroundColor DarkGray } }

function Exit2([string]$reason) {
  # 「我的环境读不到输入」不是对被测对象的判决。
  $o = [ordered]@{
    tool = 'desktop-diff'; ok = $false; verdict = 'UNMEASURED'
    exit = 2; reason = $reason
    frames = 0; pairs = 0; notes = @($script:Notes)
  }
  if ($Json) { $o | ConvertTo-Json -Depth 6 -Compress } else { Write-Host ('  没能测量：' + $reason) -ForegroundColor Yellow }
  exit 2
}

try {
  Add-Type -AssemblyName System.Drawing
} catch {
  Exit2 ('加载 System.Drawing 失败，无法解码图片：' + $_.Exception.Message)
}

# 固定尺寸灰度取样。用 LockBits 一次拷出来：GetPixel 在 PowerShell 里
# 每帧要一万多次跨边界调用，22 对帧就慢到不可用。
function Get-GrayVector([string]$path) {
  $bmp = $null; $small = $null; $g = $null
  try {
    $bmp = [System.Drawing.Bitmap]::new((Resolve-Path -LiteralPath $path).ProviderPath)
    $small = New-Object System.Drawing.Bitmap($CmpWidth, $CmpHeight)
    $g = [System.Drawing.Graphics]::FromImage($small)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Bilinear
    $g.DrawImage($bmp, 0, 0, $CmpWidth, $CmpHeight)
  } finally {
    if ($g) { $g.Dispose() }
    if ($bmp) { $bmp.Dispose() }
  }
  $rect = New-Object System.Drawing.Rectangle(0, 0, $CmpWidth, $CmpHeight)
  $data = $null
  try {
    # 统一转成 24bpp ABGR 再读，避免 32bpp 预乘/调色板带来的读数差异。
    $conv = New-Object System.Drawing.Bitmap($CmpWidth, $CmpHeight, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $gc = [System.Drawing.Graphics]::FromImage($conv)
    $gc.DrawImage($small, 0, 0, $CmpWidth, $CmpHeight)
    $gc.Dispose()
    $small.Dispose(); $small = $conv
    $data = $small.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $n = [Math]::Abs($data.Stride) * $CmpHeight
    $buf = New-Object byte[] $n
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $buf, 0, $n)
    $stride = [Math]::Abs($data.Stride)
    $out = New-Object double[] ($CmpWidth * $CmpHeight)
    $i = 0
    for ($y = 0; $y -lt $CmpHeight; $y++) {
      $row = $y * $stride
      for ($x = 0; $x -lt $CmpWidth; $x++) {
        $b = $row + $x * 3
        # BT.601 亮度，够用且与 python 侧 PIL.convert('L') 同量级
        $out[$i] = 0.114 * $buf[$b] + 0.587 * $buf[$b + 1] + 0.299 * $buf[$b + 2]
        $i++
      }
    }
    return , $out
  } finally {
    if ($small) {
      try { if ($data) { $small.UnlockBits($data) } } catch { }
      $small.Dispose()
    }
  }
}

function Compare-Vectors([double[]]$a, [double[]]$b) {
  $sum = 0.0
  for ($i = 0; $i -lt $a.Length; $i++) { $sum += [Math]::Abs($a[$i] - $b[$i]) }
  # 除以 255 让结果与位深无关；落在 [0,1]。
  return ($sum / $a.Length) / 255.0
}

# ── 采集 ────────────────────────────────────────────────────────────
$shots = New-Object System.Collections.ArrayList   # @{ name; path }

if ($Follow) {
  if ($Hwnd -le 0 -and -not $Region) {
    Exit2 '连拍模式既没给 -Hwnd 也没给 -Region：不知道该拍哪里。'
  }
  Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class DD_Win {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
'@ -ErrorAction Stop
  $tmpDir = Join-Path $env:TEMP ('ddiff-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
  $geo = $null
  if ($Hwnd -gt 0) {
    $r = New-Object DD_Win+RECT
    if (-not [DD_Win]::GetWindowRect([IntPtr]$Hwnd, [ref]$r)) { Exit2 ("GetWindowRect 拿到 0x{0:X} 失败（窗口可能已关闭）" -f $Hwnd) }
    $geo = @{ x = $r.Left; y = $r.Top; w = ($r.Right - $r.Left); h = ($r.Bottom - $r.Top) }
    Note ("窗口 hwnd=0x{0:X} 区域 {1}x{2} @({3},{4})" -f $Hwnd, $geo.w, $geo.h, $geo.x, $geo.y)
  } else {
    $p = $Region -split ','
    if ($p.Count -ne 4) { Exit2 ('-Region 需要 "x,y,w,h"，收到 "' + $Region + '"') }
    $geo = @{ x = [int]$p[0]; y = [int]$p[1]; w = [int]$p[2]; h = [int]$p[3] }
    Note ("区域 {0}x{1} @({2},{3})" -f $geo.w, $geo.h, $geo.x, $geo.y)
  }
  if ($geo.w -le 0 -or $geo.h -le 0) { Exit2 ('抓取区域尺寸非正：' + $geo.w + 'x' + $geo.h) }
  for ($k = 0; $k -lt $Count; $k++) {
    try {
      $bmp = New-Object System.Drawing.Bitmap($geo.w, $geo.h)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($geo.x, $geo.y, 0, 0, (New-Object System.Drawing.Size($geo.w, $geo.h)))
      $g.Dispose()
      $f = Join-Path $tmpDir ('f{0:d3}.png' -f $k)
      $bmp.Save($f, [System.Drawing.Imaging.ImageFormat]::Png)
      $bmp.Dispose()
      [void]$shots.Add(@{ name = ('f{0:d3}' -f $k); path = $f })
    } catch {
      Note ('第 ' + $k + ' 张抓取失败：' + $_.Exception.Message)
    }
    if ($k -lt $Count - 1) { Start-Sleep -Milliseconds $IntervalMs }
  }
} else {
  if (-not $FramesDir) { Exit2 '没给 -FramesDir。要么给帧目录，要么用 -Follow 连拍。' }
  if (-not (Test-Path -LiteralPath $FramesDir -PathType Container)) {
    Exit2 ('帧目录不存在：' + $FramesDir)
  }
  $files = @(Get-ChildItem -LiteralPath $FramesDir -Filter $Pattern -File -ErrorAction SilentlyContinue |
             Sort-Object Name)
  if ($files.Count -eq 0) {
    Exit2 ('帧目录里没有匹配 "' + $Pattern + '" 的文件：' + $FramesDir + '  —— 0 张不是「全部一致」')
  }
  foreach ($f in $files) { [void]$shots.Add(@{ name = $f.Name; path = $f.FullName }) }
}

if ($shots.Count -lt 2) {
  Exit2 ('只拿到 ' + $shots.Count + ' 帧，少于 2 帧无法比较。不是「全部一致」。')
}

# ── 比较 ────────────────────────────────────────────────────────────
$vecs = @{}
$hashCount = @{}
foreach ($s in $shots) {
  try {
    $vecs[$s.name] = Get-GrayVector $s.path
  } catch {
    Exit2 ('解码失败 ' + $s.name + '：' + $_.Exception.Message)
  }
  # 去重指纹是**另一个**指标，不参与变化判定，单独报。
  $h = (Get-FileHash -LiteralPath $s.path -Algorithm SHA256).Hash.Substring(0, 16)
  if (-not $hashCount.ContainsKey($h)) { $hashCount[$h] = 0 }
  $hashCount[$h]++
}

$perPair = New-Object System.Collections.ArrayList
$changed = 0
for ($i = 0; $i -lt $shots.Count - 1; $i++) {
  $a = $shots[$i]; $b = $shots[$i + 1]
  $d = Compare-Vectors $vecs[$a.name] $vecs[$b.name]
  $isChanged = $d -gt 0.02   # 与当初那个一次性脚本同阈，便于和历史结论对齐
  if ($isChanged) { $changed++ }
  [void]$perPair.Add([ordered]@{
      a = $a.name; b = $b.name
      delta = [Math]::Round($d, 6); changed = $isChanged
    })
}
$pairs = $shots.Count - 1
$ratio = if ($pairs -gt 0) { $changed / $pairs } else { 0 }
$distinct = $hashCount.Keys.Count

$verdict = if ($ratio -ge $MinChangedRatio) { 'MOVING' } else { 'FROZEN' }
$code = if ($verdict -eq 'MOVING') { 0 } else { 1 }

$result = [ordered]@{
  tool           = 'desktop-diff'
  ok             = ($verdict -eq 'MOVING')
  verdict        = $verdict
  exit           = $code
  mode           = $(if ($Follow) { 'follow' } else { 'dir' })
  source         = $(if ($Follow) { $(if ($Hwnd -gt 0) { "hwnd:0x$('{0:X}' -f $Hwnd)" } else { "region:$Region" }) } else { $FramesDir })
  pattern        = $(if ($Follow) { $null } else { $Pattern })
  frames         = $shots.Count
  pairs          = $pairs
  changed        = $changed
  changedRatio   = [Math]::Round($ratio, 4)
  minChangedRatio = $MinChangedRatio
  deltaThreshold = 0.02
  cmpSize        = "$CmpWidth`x$CmpHeight"
  distinctByHash = $distinct
  # 去重数与变化数**可能不同**且都不该被当成另一个：文件字节不同但画面相同是正常的
  # （PNG 重编码），画面变化但哈希相同则不可能。两个都报，避免任一被单独当结论。
  note_hash      = 'distinctByHash 是按文件字节去重，与画面变化量不是同一个指标'
  measuredAt     = (Get-Date).ToString('o')
  notes          = @($script:Notes)
  perPair        = $perPair
}

if ($Follow) {
  # 连拍只是临时产物，不留在仓库里。
  try { Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue } catch { }
}

if ($Json) {
  $result | ConvertTo-Json -Depth 6
} else {
  Write-Host ''
  Write-Host ('  来源 ' + $result.source + '  帧 ' + $shots.Count + '  对比 ' + $pairs + ' 对  尺寸 ' + $result.cmpSize)
  Write-Host ('  变化 ' + $changed + '/' + $pairs + ' = ' + [Math]::Round($ratio * 100, 1) + '%  （阈值 ' + $MinChangedRatio + '，单对阈值 0.02）')
  Write-Host ('  按字节去重 ' + $distinct + '/' + $shots.Count + ' 张不同  ← 另一个指标，不参与判定')
  Write-Host ''
  foreach ($p in $perPair) {
    $mark = if ($p.changed) { '变' } else { '  ' }
    Write-Host ('    ' + $mark + '  ' + $p.delta.ToString('0.000000').PadLeft(10) + '  ' + $p.a + ' -> ' + $p.b)
  }
  Write-Host ''
  $col = if ($code -eq 0) { 'Green' } else { 'Yellow' }
  Write-Host ('  结论 ' + $verdict + '  exit ' + $code) -ForegroundColor $col
  if ($code -eq 1) {
    Write-Host '  画面基本没动。若这是布线阶段的帧，说明它拍不到布线过程 —— 不是帧率问题。' -ForegroundColor Yellow
  }
}

exit $code
