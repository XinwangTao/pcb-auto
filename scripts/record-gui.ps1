# 真实录屏：定位文档窗口 -> 启动 ffmpeg 定点录制 -> 并行用 CLI 驱动界面 -> 停止录制。
# 产出 out\gui-raw.mp4，用于最终剪辑。
param(
  [string]$ProjectUuid = '',
  [string]$OutFile = 'out\gui-raw.mp4',
  [int]$Sec = 60,
  [int]$W = 1280,
  [int]$H = 800
)

$ErrorActionPreference = 'Stop'
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

# 1. 摆窗
$pos = pwsh -NoProfile -File scripts\position-editor.ps1 -X 0 -Y 0 -W $W -H $H 2>&1 | Out-String
$posObj = $pos | ConvertFrom-Json
if (-not $posObj.ok) { Write-Output "摆窗失败: $pos"; exit 1 }
Write-Output "文档窗口: $($posObj.rect) hwnd=$($posObj.hwnd)"

# 2. 删旧文件
if (Test-Path $OutFile) { Remove-Item $OutFile -Force }

# 3. 启动 ffmpeg 录制该窗口
#    gdigrab 支持按窗口标题抓，但标题含中文/版本号易变；改用 desktop + offset 更稳
$ffArgs = @(
  '-hide_banner', '-loglevel', 'warning',
  '-f', 'gdigrab', '-framerate', '30',
  '-offset_x', "$($posObj.x)", '-offset_y', "$($posObj.y)",
  '-video_size', "$($posObj.w)x$($posObj.h)",
  '-i', 'desktop',
  '-t', "$Sec",
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
  '-pix_fmt', 'yuv420p',
  '-y', $OutFile
)
Write-Output "开始录制 ${Sec}s ..."
$ff = Start-Process -FilePath $ffmpeg -ArgumentList $ffArgs -PassThru -NoNewWindow

# 4. 等 ffmpeg 真正开始抓帧
Start-Sleep -Seconds 2

# 5. 驱动界面
$sid = (Get-Content .session-gui -Raw).Trim()
if (-not $ProjectUuid) {
  # 取最近一个成功的工程
  $ProjectUuid = python -c "
import json,glob,os
dirs=sorted([d for d in glob.glob('out/*') if os.path.isdir(d)],key=os.path.getmtime,reverse=True)
for d in dirs:
    rj=os.path.join(d,'_run.json')
    if not os.path.exists(rj): continue
    v=json.load(open(rj,encoding='utf-8')).get('value',{})
    if v.get('ok'):
        print(v.get('projectUuid')); break
"
}

$demoArgs = @{ projectUuid = $ProjectUuid.Trim(); nets = @('GND','3V3','XTAL_IN','XTAL_OUT'); stepMs = 1400 } | ConvertTo-Json -Compress
Write-Output "驱动工程: $ProjectUuid"

& $cli invoke --session $sid --ext-uuid eda --code-file scripts\_demo_view.js --args $demoArgs --timeout 240000 2>&1 | Out-String | Write-Output

# 6. 等录制结束
$ff.WaitForExit(($Sec + 30) * 1000) | Out-Null
if (-not $ff.HasExited) { $ff.Kill() }

if (Test-Path $OutFile) {
  $sz = (Get-Item $OutFile).Length
  Write-Output "录制完成: $OutFile ($([math]::Round($sz/1MB,2)) MB)"
  & $ffprobe -v error -show_entries format=duration -show_entries stream=width,height,r_frame_rate -of default=noprint_wrappers=1 $OutFile 2>&1 | Out-String | Write-Output
} else {
  Write-Output '录制失败: 无输出文件'
  exit 1
}
