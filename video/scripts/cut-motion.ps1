# cut-motion.ps1 · 从真实屏录里切出「真的在动」的片段，并写明倍速
#
# 为什么需要它：用户对用静态截图拼的片子不满意——「你弄图片谁知道你弄了多久」。
# 要证明「AI 很快」，画面必须是**运动**，而且倍速必须是可核对的数字，
# 不是嘴上说「加速了」。
#
# 倍速窗口的算法（不是估的）：
#   合成里每段 77 帧 / 30fps = 2.5667 s（见 PcbRealV11.jsx 的 SEG）
#   片段源窗口 = 段长 × 倍速   ⇒ 播放时正好填满一段，不用运行时再变速
#   ⟹ 屏幕上写的「32×」和片子的实际时长严格自洽
#
# 阶段秒数来自**里程碑帧的写入时刻**（out/frames/REAL_<ts>/ 下每张 PNG 的 mtime
# 减去录像起点），不是看一遍猜的。实测 2026-11-27 10:07 那一轮：
#   原理图连线 116s / 导入 131.4s / 布局 133.8s / 铺铜 141.8s /
#   布线 148.7–301.2s / 布通 317.6s / DRC 343.7s
#
# 用法：pwsh -NoProfile -File video\scripts\cut-motion.ps1
# 退出码：0 成功 / 2 缺输入 / 1 切出来的片段不过验证
[CmdletBinding()]
param(
  [string]$Src,                                   # 源屏录
  [string]$OutDir,
  [int]$SegFrames = 110,
  [int]$Fps = 30,
  [string]$Ffmpeg = $env:PCB_AUTO_FFMPEG,
  [string]$Ffprobe = $env:PCB_AUTO_FFPROBE
)

$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$Video = Split-Path $Here -Parent
$Root = Split-Path $Video -Parent
if (-not $Src) { $Src = Join-Path $Root 'out\gui-v11-real.mp4' }
if (-not $OutDir) { $OutDir = Join-Path $Video 'out\motion' }
$Ffmpeg = if ($Ffmpeg) { $Ffmpeg } else { (Get-Command ffmpeg -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source }
$Ffprobe = if ($Ffprobe) { $Ffprobe } else { (Get-Command ffprobe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source }
if (-not $Ffmpeg -or -not (Test-Path $Ffmpeg)) { Write-Host '缺 ffmpeg（可用 PCB_AUTO_FFMPEG 指定）' -ForegroundColor Red; exit 2 }
if (-not (Test-Path $Src)) { Write-Host "缺源屏录：$Src" -ForegroundColor Red; exit 2 }

# 【自动缩放】auto-zoom.py 量出板子在录屏里的位置，这里拿来当裁剪框。
# 用户要求：首尾保持全窗视角，AI 操作时放大到板子。
$zoomFile = Join-Path $Video 'out\motion\zoom.json'
$ZoomByName = @{}
if (Test-Path $zoomFile) {
  $zj = Get-Content $zoomFile -Raw | ConvertFrom-Json
  foreach ($z in $zj.clips) { $ZoomByName[$z.name] = $z }
  $nz = @($zj.clips | Where-Object { $_.mode -eq 'zoom' }).Count
  $nw = @($zj.clips | Where-Object { $_.mode -eq 'wide' }).Count
  Write-Host ("  缩放清单：放大 $nz 段 / 宽景 $nw 段（板子 bbox $($zj.boardBBox.x0),$($zj.boardBBox.y0)-$($zj.boardBBox.x1),$($zj.boardBBox.y1)）") -ForegroundColor DarkGray
} else {
  Write-Host '  没有 zoom.json ⇒ 全部按全窗不裁（先跑 python video\scripts\auto-zoom.py）' -ForegroundColor DarkYellow
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$seg = $SegFrames / $Fps

# beatId 对应 public\v11\manifest.json 里的 beats[].id
# start/speed 见文件头部注释：窗口 = seg × speed，且必须落在该阶段的真实秒数区间内
$CLIPS = @(
  # 窗口 = 段长 × 倍速，且必须落在该阶段的真实秒数区间内（见文件头部的阶段时间轴）。
  # SEG=110（3.667s）之后窗口变长，所以倍速普遍下降——这是手术的代价：
  # 同样的片段越长，就需要越低的压缩比。不虚标倍数。
  @{ beat = 'pcb-imported'; name = 'm1-import'; start = 112.0; speed = 5  },  # 原理图收尾 → 导入 PCB（111–131）
  @{ beat = 'pcb-layout';   name = 'm2-layout'; start = 131.5; speed = 3  },  # 布局（131–142）
  @{ beat = 'pcb-pour';     name = 'm3-pour';   start = 142.0; speed = 2  },  # 铺铜（141.8–148.7）
  @{ beat = 'route';        name = 'm4-route';  start = 180.0; speed = 32 },  # 布线（148.7–301.2）
  @{ beat = 'pcb-routed';   name = 'm5-routed'; start = 318.0; speed = 7  },  # 布通 → DRC（317.6–343.7）
  @{ beat = 'pcb-bottom';   name = 'm6-bottom'; start = 319.0; speed = 3  },  # 翻底层
  @{ beat = 'pcb-stitched'; name = 'm7-stitch'; start = 325.0; speed = 3  },  # 缝合
  @{ beat = 'pcb-clearance'; name = 'm8-clear'; start = 331.0; speed = 3  }   # 间距修复
)

$rows = @()
foreach ($c in $CLIPS) {
  $win = [Math]::Round($seg * $c.speed, 3)
  $out = Join-Path $OutDir ($c.name + '.mp4')
  # 【裁剪在加速之后做】因为加速不改坐标，而 crop 的坐标是按**原始尺寸**量出来的。
  # 缩放方向也不一样：宽景按宽度 1280（横向），放大段按**高度** 1280（竖向）。
  # 用错方向会得到 1280×3594 这种荒谬尺寸。
  $zp = $ZoomByName[$c.name]
  $vf = "[0:v]setpts=(PTS-STARTPTS)/$($c.speed),fps=$Fps"
  if ($zp -and $zp.crop) {
    $cw = [int]$zp.crop.w; $ch = [int]$zp.crop.h; $cx = [int]$zp.crop.x; $cy = [int]$zp.crop.y
    $vf += ",crop=${cw}:${ch}:${cx}:${cy},scale=-2:1280"
  } else {
    $vf += ",scale=1280:-2"
  }
  & $Ffmpeg -v error -y -ss $c.start -t $win -i $Src `
    -filter_complex $vf `
    -an -c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p $out
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $out)) { Write-Host "切 $($c.name) 失败" -ForegroundColor Red; exit 1 }

  $probe = (& $Ffprobe -v error -select_streams v:0 -show_entries 'stream=width,height,nb_frames,pix_fmt' -show_entries 'format=duration' -of csv=p=0 $out | Out-String).Trim()
  $parts = ($probe -split ',')
  $w = [int]$parts[0]; $h = [int]$parts[1]
  $durLine = ($probe -split "`n" | Where-Object { $_ -match '^\d+\.\d+$' } | Select-Object -Last 1)
  $dur = [double]($durLine -as [double])
  $nf = [int](& $Ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames -of csv=p=0 $out)

  # 验证：必须真的是两段不同画面（静止冒充运动是本任务最容易被糊弄过去的地方）
  $a = Join-Path $env:TEMP ("cm-a-$($c.name).png"); $b = Join-Path $env:TEMP ("cm-b-$($c.name).png")
  & $Ffmpeg -v error -y -i $out -vf 'select=eq(n\,0)' -vframes 1 $a 2>&1 | Out-Null
  & $Ffmpeg -v error -y -i $out -vf "select=eq(n\,$([Math]::Max(0,$nf-1)))" -vframes 1 $b 2>&1 | Out-Null
  $same = (Get-FileHash $a -Algorithm SHA256).Hash -eq (Get-FileHash $b -Algorithm SHA256).Hash
  if ($same) { Write-Host "$($c.name) 首末帧相同 ⇒ 静止冒充运动，拒绝" -ForegroundColor Red; exit 1 }

  $rows += [pscustomobject]@{
    beat = $c.beat; name = $c.name
    srcFile = (Split-Path $Src -Leaf)
    srcStart = $c.start; srcWindowSec = $win; speed = $c.speed
    outFile = ('v11motion/' + $c.name + '.mp4')
    outDurSec = [Math]::Round($dur, 3); outFrames = $nf
    w = $w; h = $h
    zoomMode = $(if ($zp -and $zp.crop) { 'zoom' } else { 'wide' })
    zoomFactorArea = $(if ($zp) { $zp.zoomFactorArea } else { 1.0 })
    firstLastDiffer = $true
  }
  Write-Host ("  {0,-11} 源 {1,6}s +{2,7}s @{3,2}x → {4} 帧 / {5}s  {6}x{7}  {8}" -f $c.name, $c.start, $win, $c.speed, $nf, [Math]::Round($dur,2), $w, $h, $(if ($zp -and $zp.crop) { "**放大×$($zp.zoomFactorArea)**" } else { "全窗" }))
}

$manifest = [pscustomobject]@{
  generatedAt = (Get-Date).ToString('o')
  generator = 'video/scripts/cut-motion.ps1'
  segFrames = $SegFrames; fps = $Fps
  source = (Split-Path $Src -Leaf)
  clips = $rows
}
$jsonPath = Join-Path $OutDir 'clips.json'
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $jsonPath -Encoding utf8
Write-Host ""
Write-Host "已写 $jsonPath（$($rows.Count) 段）" -ForegroundColor Green
exit 0
