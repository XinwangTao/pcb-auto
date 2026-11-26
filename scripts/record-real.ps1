# 真实全流程录屏 v2：
#   1) 只保留一个 GUI session（多 session 会各建窗口并叠在 0,0，录到别人的界面）
#   2) 最小化遮挡窗口，EDA 置顶
#   3) 预热，消除 60s 冷启动
#   4) 全程录制 pipeline3 真实操作（建工程/放器件/拉线/布局/布线/DRC/导出）
#   5) 录制期间起一个看门狗，持续把 EDA 拉回前台，防止被别的窗口抢焦点
param(
  [string]$Design = 'designs\d3-sht30-ldo.json',
  [string]$OutFile = 'out\gui-real.mp4',
  [int]$W = 1280, [int]$H = 800, [int]$Fps = 30,
  [int]$MaxSec = 300
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
. (Join-Path $PSScriptRoot 'tool-paths.ps1')

# ffmpeg / ffprobe：不再写死某个开发者本机的安装目录。
# 先看环境变量，再看 PATH；都不中就给一条能照做的错。
$ffmpeg = $env:PCB_AUTO_FFMPEG
if (-not $ffmpeg) {
  $c = Get-Command ffmpeg -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { $ffmpeg = $c.Source }
}
if (-not $ffmpeg) { throw "找不到 ffmpeg（只有录制/合成视频时才需要）。装好后确保它在 PATH 上，或设置 `$env:PCB_AUTO_FFMPEG 指向 ffmpeg.exe。" }
$ffprobe = $env:PCB_AUTO_FFPROBE
if (-not $ffprobe) {
  $c = Get-Command ffprobe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { $ffprobe = $c.Source }
}
if (-not $ffprobe) { throw "找不到 ffprobe（与 ffmpeg 装在同一目录）。装好后确保它在 PATH 上，或设置 `$env:PCB_AUTO_FFPROBE 指向 ffprobe.exe。" }
$cli = Resolve-LcedaCli
$sid = (Get-Content .session-gui -Raw).Trim()

# 1) 环境准备
$prep = pwsh -NoProfile -File scripts\prep-record.ps1 -X 0 -Y 0 -W $W -H $H -MinimizeOthers 2>&1 | Out-String
$p = $prep | ConvertFrom-Json
if (-not $p.ok) { Write-Output "环境准备失败: $prep"; exit 1 }
Write-Output "EDA 窗口: hwnd=$($p.hwnd) $($p.w)x$($p.h)@$($p.x),$($p.y) 最小化其他窗口 $($p.minimized) 个"

# 2) 生成 pipeline args
$designObj = Get-Content $Design -Raw | ConvertFrom-Json
$stamp = Get-Date -Format 'HHmmss'
$pipelineArgs = @{
  design     = $designObj
  outDir     = (Join-Path $root "out\REAL_$stamp")
  recordMode = $true
} | ConvertTo-Json -Depth 20 -Compress
$argsTmp = 'out\rec-args.json'
Set-Content -Path $argsTmp -Value $pipelineArgs -NoNewline -Encoding UTF8

# 3) 预热
Write-Output '预热 ...'
& $cli invoke --session $sid --ext-uuid eda --code-file scripts\_warmup.js --args '{"projectUuid":""}' --timeout 180000 2>&1 | Out-String | Out-Null
pwsh -NoProfile -File scripts\prep-record.ps1 -X 0 -Y 0 -W $W -H $H 2>&1 | Out-String | Out-Null
Start-Sleep -Seconds 2

# 4) 录制
if (Test-Path $OutFile) { Remove-Item $OutFile -Force }
$ffArgs = @(
  '-hide_banner','-loglevel','error',
  '-f','gdigrab','-framerate',"$Fps",
  '-offset_x',"$($p.x)",'-offset_y',"$($p.y)",
  '-video_size',"$($p.w)x$($p.h)",
  '-i','desktop','-t',"$MaxSec",
  '-c:v','libx264','-preset','veryfast','-crf','20',
  '-pix_fmt','yuv420p','-y',$OutFile
)
Write-Output "开始录制（上限 ${MaxSec}s）..."
$ff = Start-Process -FilePath $ffmpeg -ArgumentList $ffArgs -PassThru -NoNewWindow
Start-Sleep -Seconds 3

# 5) 看门狗：每 2 秒把 EDA 拉回前台（后台 job）
$watchScript = {
  param($hwnd, $scriptPath)
  while ($true) {
    try {
      $null = pwsh -NoProfile -File $scriptPath -X 0 -Y 0 -W 1280 -H 800 2>&1
    } catch {}
    Start-Sleep -Seconds 2
  }
}
$watch = Start-Job -ScriptBlock $watchScript -ArgumentList $p.hwnd, (Join-Path $root 'scripts\prep-record.ps1')

# 6) 跑真实流水线
Write-Output '运行 pipeline3 ...'
$t0 = Get-Date
$raw = (& $cli invoke --session $sid --ext-uuid eda --code-file scripts\pipeline3.js --args (Get-Content $argsTmp -Raw) --timeout 900000 2>&1 | Out-String)
$elapsed = ((Get-Date) - $t0).TotalSeconds
Write-Output "pipeline 结束，耗时 $([math]::Round($elapsed,1))s"

# 7) 收尾
Stop-Job $watch -ErrorAction SilentlyContinue
Remove-Job $watch -Force -ErrorAction SilentlyContinue
$ff.WaitForExit(($MaxSec + 60) * 1000) | Out-Null
if (-not $ff.HasExited) { $ff.Kill() }

$raw | Set-Content -Path 'out\rec-result.json' -Encoding UTF8
Write-Output '结果: out\rec-result.json'

if (Test-Path $OutFile) {
  Write-Output "录制完成: $OutFile ($([math]::Round((Get-Item $OutFile).Length/1MB,2)) MB)"
  & $ffprobe -v error -show_entries format=duration -show_entries stream=width,height,r_frame_rate -of default=noprint_wrappers=1 $OutFile 2>&1 | Out-String | Write-Output
} else { Write-Output '录制失败'; exit 1 }
