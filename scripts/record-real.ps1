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
  # 300 秒只够小板的放件+连线：ESP32-S3 麦克风那类板子单次跑 500~900 秒，
  # ffmpeg 到点就停，录下来只有前半段。默认放到 20 分钟。
  [int]$MaxSec = 1200,
  # 原来这里把 invoke 的 --timeout 写死成 900000（15 分钟）。26 器件 / 111 连接的板子
  # 单次尝试就可能超过 15 分钟，CLI 一放弃等待，录制就提前结束、而且画面停在半路 ——
  # 看起来像流水线失败。改成参数，默认沿用 900 秒保持原行为。
  [int]$PipelineTimeoutSec = 900,
  # 指定要录的会话。不给就按 .session-gui → 现开一个的顺序找（见下方）。
  [string]$SessionId
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
# 【会话必须是真的 GUI 会话，而且必须活着】
# 原来这里直接 Get-Content .session-gui —— 那个文件是手工维护的。一旦会话失效，
# 后面的 invoke 只会返回 SESSION_NOT_FOUND，而 ffmpeg 照样录满 MaxSec，
# 最后得到一个「录了，但录的是空桌面」的视频。这是最坏的一种失败：看起来成功了。
# 所以：先验活；不活就自己开一个，并把新 id 写回 .session-gui。
$cli = Resolve-LcedaCli
$sid = $SessionId
if (-not $sid -and (Test-Path '.session-gui')) { $sid = (Get-Content '.session-gui' -Raw).Trim() }
if ($sid) {
  $alive = $false
  try { $alive = ((& $cli session list 2>&1 | Out-String) -match [regex]::Escape($sid)) } catch { }
  if (-not $alive) { Write-Output "会话 $sid 已失效，另开一个 GUI 会话"; $sid = $null }
}
if (-not $sid) {
  # 只留一个会话：多会话会各建一个窗口并叠在 (0,0)，录到的是别人的界面。
  try {
    $listTxt = (& $cli session list 2>&1 | Out-String)
    foreach ($m in [regex]::Matches($listTxt, '"sessionId":"([^"]+)"')) { & $cli session close $m.Groups[1].Value 2>&1 | Out-Null }
  } catch { }
  Start-Sleep -Seconds 2
  # 不带 --headless 才是带窗口的会话 —— 这是"录屏"与"画布帧"的唯一区别。
  $open = (& $cli open 2>&1 | Out-String)
  try { $sid = ($open | ConvertFrom-Json).value.sessionId } catch { }
  if (-not $sid) { Write-Output "无法开启 GUI 会话：$open"; exit 2 }
  Set-Content -Path '.session-gui' -Value $sid -NoNewline
  Write-Output "新 GUI 会话 $sid（已写入 .session-gui）"
}

# 1) 环境准备
$prep = pwsh -NoProfile -File scripts\prep-record.ps1 -X 0 -Y 0 -W $W -H $H -MinimizeOthers 2>&1 | Out-String
$p = $prep | ConvertFrom-Json
if (-not $p.ok) { Write-Output "环境准备失败: $prep"; exit 1 }
Write-Output "EDA 窗口: hwnd=$($p.hwnd) $($p.w)x$($p.h)@$($p.x),$($p.y) 最小化其他窗口 $($p.minimized) 个"

# 2) 生成 pipeline args
$designObj = Get-Content $Design -Raw | ConvertFrom-Json
$stamp = Get-Date -Format 'HHmmss'
$outDir = Join-Path $root "out\REAL_$stamp"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
# 【framesDir 必须传，而且目录必须事先存在】
# pipeline3.js 里 `const FRAMES = REC ? String(A.framesDir || '') : ''`，
# 而 shot() 第一行就是 `if (!REC || !FRAMES) return null` ——
# 原来这里只传 recordMode 不传 framesDir，于是整整一跑一张画布帧都存不下，
# 日志里连一条 shotNone 都没有（因为它根本没进 shot）。
# 另外 EDA 的 saveFileToFileSystem 需要目录已存在，否则返回 false 且不报错。
$framesDir = Join-Path $root "out\frames\REAL_$stamp"
New-Item -ItemType Directory -Force -Path $framesDir | Out-Null
$pipelineArgs = @{
  design     = $designObj
  outDir     = $outDir
  recordMode = $true
  framesDir  = $framesDir
  # budgetMs 不给的话 pipeline3 用缺省 530000（约 8.8 分钟）自动收尾，
  # 与这里的 --timeout 无关 —— 会表现成"录到一半自己停了"。
  budgetMs   = ($PipelineTimeoutSec * 1000 - 60000)
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
      # -NoMove：只把窗口拉到前台，不再每 2 秒改一次位置/大小（否则录制画面会抖）
    $null = pwsh -NoProfile -File $scriptPath -NoMove 2>&1
    } catch {}
    Start-Sleep -Seconds 2
  }
}
$watch = Start-Job -ScriptBlock $watchScript -ArgumentList $p.hwnd, (Join-Path $root 'scripts\prep-record.ps1')

# 6) 跑真实流水线
Write-Output '运行 pipeline3 ...'
$t0 = Get-Date
$raw = (& $cli invoke --session $sid --ext-uuid eda --code-file scripts\pipeline3.js --args (Get-Content $argsTmp -Raw) --timeout ($PipelineTimeoutSec * 1000) 2>&1 | Out-String)
$elapsed = ((Get-Date) - $t0).TotalSeconds
Write-Output "pipeline 结束，耗时 $([math]::Round($elapsed,1))s"

# 7) 收尾
Stop-Job $watch -ErrorAction SilentlyContinue
Remove-Job $watch -Force -ErrorAction SilentlyContinue
$ff.WaitForExit(($MaxSec + 60) * 1000) | Out-Null
if (-not $ff.HasExited) { $ff.Kill() }

$raw | Set-Content -Path 'out\rec-result.json' -Encoding UTF8
Write-Output '结果: out\rec-result.json'
# 画布帧单独计数并报出来：录屏与画布帧是两种素材，不能混成一个"成功"。
$nFrames = @(Get-ChildItem $framesDir -Filter '*.png' -ErrorAction SilentlyContinue).Count
Write-Output "画布帧: $nFrames 张 -> $framesDir"

if (Test-Path $OutFile) {
  Write-Output "录制完成: $OutFile ($([math]::Round((Get-Item $OutFile).Length/1MB,2)) MB)"
  & $ffprobe -v error -show_entries format=duration -show_entries stream=width,height,r_frame_rate -of default=noprint_wrappers=1 $OutFile 2>&1 | Out-String | Write-Output
} else { Write-Output '录制失败'; exit 1 }
