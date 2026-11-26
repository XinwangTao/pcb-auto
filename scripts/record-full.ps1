# 真实全流程录屏：把 pipeline3.js 放到 GUI 会话里跑，全程录制 LCEDA 真实界面。
# 与之前「事后浏览」不同，这里录的是从建工程、放器件、拉线、PCB 布局、布线、DRC 到导出的完整过程。
param(
  [string]$Design = 'designs\d5-led-indicator.json',
  [string]$OutFile = 'out\gui-full.mp4',
  [int]$W = 1280,
  [int]$H = 800,
  [int]$Fps = 30,
  [int]$WarmupSec = 5,
  [int]$MaxSec = 420
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$ffmpeg = 'C:\ffmpeg\bin\ffmpeg.exe'
$ffprobe = 'C:\ffmpeg\bin\ffprobe.exe'
$cli = 'E:\APP\lceda-pro\lceda-pro.exe'
$sid = (Get-Content .session-gui -Raw).Trim()

# ---------- 1. 先把窗口摆好 ----------
$pos = pwsh -NoProfile -File scripts\position-editor.ps1 -X 0 -Y 0 -W $W -H $H 2>&1 | Out-String
$posObj = $pos | ConvertFrom-Json
if (-not $posObj.ok) { Write-Output "摆窗失败: $pos"; exit 1 }
Write-Output "文档窗口: $($posObj.rect) hwnd=$($posObj.hwnd)"

# ---------- 2. 生成 pipeline args ----------
$argsTmp = 'out\rec-args.json'
$designObj = Get-Content $Design -Raw | ConvertFrom-Json
# pipeline3 只读 design 和 outDir
$pipelineArgs = @{
  design = $designObj
  outDir = (Join-Path $root ("out\LIVE_" + (Get-Date -Format 'HHmmss')))
} | ConvertTo-Json -Depth 20 -Compress
Set-Content -Path $argsTmp -Value $pipelineArgs -NoNewline -Encoding UTF8
Write-Output "args 大小: $((Get-Item $argsTmp).Length) B"

# ---------- 3. 预热（消除 60s 冷启动，否则录制开头全是空等）----------
Write-Output '预热中 ...'
$warmArgs = '{"projectUuid":""}'
& $cli invoke --session $sid --ext-uuid eda --code-file scripts\_warmup.js --args $warmArgs --timeout 180000 2>&1 | Out-String | Out-Null
Write-Output '预热完成'

Start-Sleep -Seconds $WarmupSec

# ---------- 4. 启动录制 ----------
if (Test-Path $OutFile) { Remove-Item $OutFile -Force }
$ffArgs = @(
  '-hide_banner', '-loglevel', 'error',
  '-f', 'gdigrab', '-framerate', "$Fps",
  '-offset_x', "$($posObj.x)", '-offset_y', "$($posObj.y)",
  '-video_size', "$($posObj.w)x$($posObj.h)",
  '-i', 'desktop',
  '-t', "$MaxSec",
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
  '-pix_fmt', 'yuv420p',
  '-y', $OutFile
)
Write-Output "开始录制（上限 ${MaxSec}s，跑到 pipeline 结束）..."
$ff = Start-Process -FilePath $ffmpeg -ArgumentList $ffArgs -PassThru -NoNewWindow
Start-Sleep -Seconds 3

# ---------- 5. 跑真实流水线 ----------
Write-Output '运行 pipeline3（真实画图/布线/导出）...'
$t0 = Get-Date
$raw = (& $cli invoke --session $sid --ext-uuid eda --code-file scripts\pipeline3.js --args (Get-Content $argsTmp -Raw) --timeout 900000 2>&1 | Out-String)
$elapsed = ((Get-Date) - $t0).TotalSeconds
Write-Output "pipeline 结束，耗时 $([math]::Round($elapsed,1))s"

# ---------- 6. 等录制自然结束（-t 到点自动收尾，文件一定可播）----------
Write-Output '等待录制收尾 ...'
$ff.WaitForExit(($MaxSec + 60) * 1000) | Out-Null
if (-not $ff.HasExited) { $ff.Kill(); Write-Output '超时强杀 ffmpeg' }

# ---------- 7. 保存 pipeline 结果 ----------
$raw | Set-Content -Path 'out\rec-pipeline-result.json' -Encoding UTF8
Write-Output "结果已存 out\rec-pipeline-result.json"

if (Test-Path $OutFile) {
  $sz = (Get-Item $OutFile).Length
  Write-Output "录制完成: $OutFile ($([math]::Round($sz/1MB,2)) MB)"
  & $ffprobe -v error -show_entries format=duration -show_entries stream=width,height,r_frame_rate -of default=noprint_wrappers=1 $OutFile 2>&1 | Out-String | Write-Output
} else {
  Write-Output '录制失败'
  exit 1
}
