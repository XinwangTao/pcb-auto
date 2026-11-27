# make-v11.ps1 · 一条命令拍出 v11
#
# 链路：真实画布帧 → manifest → Remotion 渲染 → 规格合规转换 → 挂 BGM
#
# 为什么中间有「合规转换」这一步（不是画蛇添足）：
#   本机 Remotion 4.0.409 渲出来**恒为 yuvj420p / color_range=pc**（实测 v10、v11 三次都是，
#   显式传 --pixel-format=yuv420p 也不改变它）。而 video\mix-and-ship.ps1 的成片硬规格是
#   yuv420p / tv，且它 -c:v copy 直通、改不了 —— 于是直接喂进去必退 3。
#   已验收的 v10 成片本身也是 yuvj420p/pc，说明这条前置条件从没被满足过。
#   所以这里用 ffmpeg 做一次合法范围映射（pc→tv，不是简单丢色），再交给混音脚本。
#
# 用法：
#   pwsh -NoProfile -File video\scripts\make-v11.ps1                # 用最新批次
#   pwsh -NoProfile -File video\scripts\make-v11.ps1 -Batch 005256
#
# 退出码：0 成功 / 2 缺输入（没有帧或没有 manifest）/ 1 渲染或转换失败
[CmdletBinding()]
param(
  [string]$Batch,
  [string]$Attempt,
  [int]$RenderRetries = 4,
  # 【不写死本机路径】与 mix-and-ship.ps1 同一套：先环境变量、再 PATH。
  # 写死一个本机绝对路径会把脚本变成只在这台机器上能跑，
  # 而 test/dev-path-scan.mjs 会当场它判成功能级违规（实测本轮就被抳到了）。
  [string]$Ffmpeg = $env:PCB_AUTO_FFMPEG,
  [string]$Ffprobe = $env:PCB_AUTO_FFPROBE
)

$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$Video = Split-Path $Here -Parent
$Root = Split-Path $Video -Parent
$Node = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
$Ffmpeg = if ($Ffmpeg) { $Ffmpeg } else { (Get-Command ffmpeg -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source }
$Ffprobe = if ($Ffprobe) { $Ffprobe } else { (Get-Command ffprobe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source }

# 【必须在 video\ 里跑】`npx remotion` 在**当前目录**的 node_modules 里找可执行文件。
# 从仓库根调本脚本时，remotion 在 video\node_modules 里，于是报
#   npm error could not determine executable to run
# 而这个报错看不出是目录问题（实测 2026-11-27 01:30 踩过）。
Push-Location $Video
try {

function Step($msg) { Write-Host ''; Write-Host ("=== $msg ===") -ForegroundColor Cyan }
function Die($msg, $code) { Write-Host "[make-v11] $msg" -ForegroundColor Red; exit $code }

if (-not $Node) { Die 'PATH 里找不到 node' 2 }
if (-not $Ffmpeg -or -not (Test-Path $Ffmpeg)) { Die "PATH 里找不到 ffmpeg（可用 PCB_AUTO_FFMPEG 指定）" 2 }
if (-not $Ffprobe -or -not (Test-Path $Ffprobe)) { Die "PATH 里找不到 ffprobe（可用 PCB_AUTO_FFPROBE 指定）" 2 }

Step '1/4 生成 manifest（按 tag 在当前批次里挑帧）'
$args1 = @((Join-Path $Here 'build-v11.mjs'))
if ($Batch) { $args1 += @('--batch', $Batch) }
if ($Attempt) { $args1 += @('--attempt', $Attempt) }
& $Node @args1
if ($LASTEXITCODE -ne 0) { Die "build-v11 失败（exit $LASTEXITCODE）—— 多半是没开录制或本批次帧不够" 2 }

# 【步骤 1b：把真实运动片段挂上】build-v11 产的是**静态画布帧**（里程碑截图）。
# 用户明确不要图片切换，要看到运动。片段由 cut-motion.ps1 从真实屏录切出
# 并把倍速焕进文件，这里只负责挂到 beats[].video 上。
Step '1b/5 挂运动片段（真实屏录 → 段）'
& $Node (Join-Path $Here 'attach-motion.mjs')
if ($LASTEXITCODE -ne 0) {
  Die '挂运动片段失败。先跑：pwsh -File video\scripts\cut-motion.ps1（需要 out\gui-v11-real.mp4）' 1
}

$Manifest = Join-Path $Video 'public\v11\manifest.json'
if (-not (Test-Path $Manifest)) { Die '没有生成 public\v11\manifest.json' 2 }
$mb = (Get-Content $Manifest -Raw | ConvertFrom-Json)
$beats = @($mb.beats).Count
$frames = (@($mb.beats) | ForEach-Object { @($_.frames).Count } | Measure-Object -Sum).Sum
Write-Host ("  段 $beats / 帧 $frames / 批次 $($mb.source.batch) / distinct $($mb.source.distinctImages)")

Step '2/4 Remotion 渲染（浏览器会偶发连不上，带重试）'
$stamp = (Get-Date).ToString('HHmmss')
$raw = Join-Path $Video "out\v11-raw-$stamp.mp4"
$env:PATH = (Split-Path $Node -Parent) + ';' + $env:PATH
$ok = $false
for ($i = 1; $i -le $RenderRetries; $i++) {
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'chrome' } |
    ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 3
  Write-Host "  第 $i 次…" -ForegroundColor DarkGray
  & npx remotion render 'src\entry.js' PcbRealV11 $raw --config=remotion.config.v10.js 2>&1 |
    Select-Object -Last 3 | ForEach-Object { Write-Host "    $_" }
  if ($LASTEXITCODE -eq 0 -and (Test-Path $raw)) { $ok = $true; break }
}
if (-not $ok) { Die "渲染 $RenderRetries 次都失败" 1 }

Step '3/4 规格合规转换（yuvj420p/pc → yuv420p/tv）'
$conf = Join-Path $Video "out\v11-conform-$stamp.mp4"
& $Ffmpeg -v error -y -i $raw -vf 'scale=in_range=pc:out_range=tv,format=yuv420p' `
  -c:v libx264 -preset slow -crf 14 -pix_fmt yuv420p `
  -color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709 `
  -c:a copy -movflags +faststart $conf
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $conf)) { Die '合规转换失败' 1 }
$probe = & $Ffprobe -v error -select_streams v:0 -show_entries 'stream=pix_fmt,color_range' -of 'csv=p=0' $conf
Write-Host "  转换后：$probe"
if ($probe -notmatch 'yuv420p' -or $probe -notmatch 'tv') { Die "转换后仍不合规：$probe" 1 }

Step '4/4 挂 BGM（V6 配方，mix-and-ship.ps1）'
& pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Video 'mix-and-ship.ps1') -Path $conf 2>&1 |
  Select-Object -Last 8 | ForEach-Object { Write-Host "  $_" }
if ($LASTEXITCODE -ne 0) { Die "混音失败（exit $LASTEXITCODE）" 1 }

$final = [IO.Path]::ChangeExtension($conf, '.mp4') -replace '\.mp4$', '-bgm.mp4'
Write-Host ''
Write-Host '成片：' -NoNewline
Write-Host $final -ForegroundColor Green
if (Test-Path $final) {
  & $Ffprobe -v error -show_entries 'stream=codec_name,width,height,r_frame_rate,nb_frames' -show_entries 'format=duration,size' -of 'default=noprint_wrappers=1' $final
}
} finally { Pop-Location }
exit 0
