# 最终录屏：真实 pipeline + 弹窗看门狗 + 镜头跟随。
# 相比前几版的关键修正：
#   1) 只保留一个 GUI session（多 session 会各建窗口、叠在 0,0，录到别人的界面）
#   2) 打开工程前先发一次 ESC，避免「设置 > 拖动网络名」模态框挡住十几秒
#   3) pipeline3 recordMode=true，每个阶段后自动拟合视图（原理图全图 / PCB 板框）
#   4) 录制区固定 1280x800，只录 EDA 编辑器窗口
param(
  [string]$Design = 'designs\d3-sht30-ldo.json',
  [string]$OutFile = 'out\gui-final.mp4',
  # 录制尺寸固定 1280x800：实测 1920x1200 下 tileAllDocumentToSplitScreen 更不稳定，
  # 出现过前 70 秒全黑、原理图只闪一帧的退化。1280x800 是唯一稳定出片的尺寸。
  # 想要"看清细节"靠后期裁剪放大（只保留绘图区），不要靠加大录制窗口。
  [int]$W = 1280, [int]$H = 800, [int]$Fps = 30,
  [int]$MaxSec = 240,
  # 预检模式：先在不录制的状态下跑一遍确定能通过的板框，再正式录制。
  # 目的：d3 的 autoLayout 非确定性，直接录可能录到失败的那次；重试又会让
  # 录制画面里出现两次建立工程。所以先试跑锁定板框，正式录制只跑一次。
  [switch]$Preflight
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
Add-Type -AssemblyName System.Windows.Forms

# ---------- 1. 环境准备 ----------
$prep = pwsh -NoProfile -File scripts\prep-record.ps1 -X 0 -Y 0 -W $W -H $H -MinimizeOthers 2>&1 | Out-String
$p = $prep | ConvertFrom-Json
if (-not $p.ok) { Write-Output "环境准备失败: $prep"; exit 1 }
Write-Output "EDA 窗口 hwnd=$($p.hwnd) $($p.w)x$($p.h)@$($p.x),$($p.y)"

# ---------- 2. pipeline args ----------
$designObj = Get-Content $Design -Raw | ConvertFrom-Json
$stamp = Get-Date -Format 'HHmmss'
$outDir = Join-Path $root "out\FINAL_$stamp"
# 画布真实渲染帧目录。必须**先建好**：管道内的 fs.saveFileToFileSystem 在目录不存在时
# 只返回 false、不抛错，会出现"跑完却没有一张帧"的静默失败。
# 帧的来源是 dmt_EditorControl.getCurrentRenderedAreaImage —— EDA 自己渲染画布，
# 不依赖桌面重绘，所以不会像 gdigrab 那样拍到 60~75% 的冻结帧。
$framesDir = Join-Path $root "video\out\frames\$stamp"
New-Item -ItemType Directory -Force -Path $framesDir | Out-Null
Write-Output "画布帧目录: $framesDir"
$payload = @{ design = $designObj; outDir = $outDir; recordMode = $true; framesDir = $framesDir } |
  ConvertTo-Json -Depth 20 -Compress
$argsTmp = 'out\rec-args.json'
Set-Content -Path $argsTmp -Value $payload -NoNewline -Encoding UTF8

# ---------- 3. 预热 + 清弹窗 ----------
Write-Output '预热 ...'
& $cli invoke --session $sid --ext-uuid eda --code-file scripts\_warmup.js --args '{"projectUuid":""}' --timeout 180000 2>&1 | Out-String | Out-Null
pwsh -NoProfile -File scripts\prep-record.ps1 -X 0 -Y 0 -W $W -H $H 2>&1 | Out-String | Out-Null
for ($i = 0; $i -lt 3; $i++) {
  [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
  Start-Sleep -Milliseconds 400
}
Start-Sleep -Seconds 2

# ---------- 4. 板框规划 ----------
# 踩坑：d3 的 autoLayout 非确定性——同样输入有时 DRC 0 违规，有时 23 处
# Connection Error。run-all.ps1 靠"加大板框重跑"自愈，但直接录会录到失败那次。
# 所以分两种模式：
#   -Preflight : 不录制，只试跑找出能通过的板框，写进 .rec-board.json
#   正常模式    : 读 .rec-board.json 里锁定的板框，只跑一次，画面干净
$baseW = [int]$designObj.boardWidthMil
$baseH = [int]$designObj.boardHeightMil
if ($baseW -le 0) { $baseW = 1200 }
if ($baseH -le 0) { $baseH = 900 }

$lockFile = 'out\.rec-board.json'
$plans = @(
  @{ w = $baseW;       h = $baseH;       tag = 'smart-fit' },
  @{ w = $baseW * 1.5; h = $baseH * 1.5; tag = 'expand-1.5x' },
  @{ w = $baseW * 2.0; h = $baseH * 2.0; tag = 'expand-2.0x' }
)

function Invoke-Pipeline([int]$bw, [int]$bh, [string]$tag) {
  $designObj.boardWidthMil = $bw
  $designObj.boardHeightMil = $bh
  New-Item -ItemType Directory -Force -Path $framesDir | Out-Null
  $payload = @{ design = $designObj; outDir = $outDir; recordMode = $true; framesDir = $framesDir } |
    ConvertTo-Json -Depth 20 -Compress
  Set-Content -Path $argsTmp -Value $payload -NoNewline -Encoding UTF8
  Write-Output "运行 pipeline3 [$tag] 板框 ${bw}x${bh} ..."
  $t0 = Get-Date
  $out = (& $cli invoke --session $sid --ext-uuid eda --code-file scripts\pipeline3.js --args (Get-Content $argsTmp -Raw) --timeout 900000 2>&1 | Out-String)
  Write-Output "  pipeline 耗时 $([math]::Round(((Get-Date)-$t0).TotalSeconds,1))s"
  return $out
}

function Test-Passed([string]$rawJson) {
  try {
    $parsed = $rawJson | ConvertFrom-Json
    if (-not ($parsed.ok -and $parsed.value)) { return $false }
    Write-Output ("  DRC: {0} 违规组 {1}" -f $parsed.value.drc.state, $parsed.value.drcDetailCount)
    return [bool]$parsed.value.ok
  } catch { Write-Output '  输出不是合法 JSON'; return $false }
}

if ($Preflight) {
  # 预检：不录屏，跑到达标为止，把板框记下来
  $found = $false
  foreach ($plan in $plans) {
    $r = Invoke-Pipeline -bw ([int]$plan.w) -bh ([int]$plan.h) -tag $plan.tag
    if (Test-Passed $r) {
      @{ w = [int]$plan.w; h = [int]$plan.h; tag = $plan.tag } |
        ConvertTo-Json -Compress | Set-Content -Path $lockFile -NoNewline -Encoding UTF8
      Write-Output "预检通过：$($plan.tag) $($plan.w)x$($plan.h)，已写入 $lockFile"
      $found = $true
      break
    }
    Write-Output "  [$($plan.tag)] 未通过，换更大板框"
  }
  if (-not $found) { Write-Output '预检全部未通过'; exit 1 }
  exit 0
}

# 正常模式：用锁定板框（没有就用第一个），只跑一次
if (Test-Path $lockFile) {
  $lock = Get-Content $lockFile -Raw | ConvertFrom-Json
  $recW = [int]$lock.w; $recH = [int]$lock.h; $recTag = $lock.tag
  Write-Output "使用锁定板框 $recW x $recH ($recTag)"
} else {
  $recW = $baseW; $recH = $baseH; $recTag = 'smart-fit'
  Write-Output "未找到锁定板框，使用默认 $recW x $recH"
}

# ---------- 5. 录制 ----------
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

# ---------- 6. 前台看门狗 ----------
# 注意：这里的尺寸必须和上面的 -W/-H 一致，否则看门狗会把窗口缩回小尺寸，
# 录到一半画面变成 1280x800 加一圈桌面。
$watch = Start-Job -ScriptBlock {
  param($sp, $x, $y, $w, $h)
  while ($true) { try { $null = pwsh -NoProfile -File $sp -X $x -Y $y -W $w -H $h 2>&1 } catch {}; Start-Sleep -Seconds 3 }
} -ArgumentList (Join-Path $root 'scripts\prep-record.ps1'), 0, 0, $W, $H

# 弹窗看门狗：SendKeys 无效（EDA 窗口常拿不到前台焦点），
# 必须用 PostMessage 把 ESC 直接投递给 Chromium 渲染子窗口。
$escWatch = Start-Job -ScriptBlock {
  param($wd)
  Set-Location $wd
  & pwsh -NoProfile -File 'scripts\kill-popup.ps1' -DurationSec 45 -IntervalMs 2500 2>&1
} -ArgumentList $root

# ---------- 7. 正式跑一次 ----------
$raw = Invoke-Pipeline -bw $recW -bh $recH -tag $recTag

Stop-Job $watch,$escWatch -ErrorAction SilentlyContinue
Remove-Job $watch,$escWatch -Force -ErrorAction SilentlyContinue

# ---------- 8. 收尾 ----------
$ff.WaitForExit(($MaxSec + 60) * 1000) | Out-Null
if (-not $ff.HasExited) { $ff.Kill() }

$raw | Set-Content -Path 'out\rec-result.json' -Encoding UTF8
# 画布帧是视频的主素材（比桌面录屏可靠得多），数量为 0 说明 shot() 没跑通，
# 必须当场报出来，否则会白白进入剪辑阶段才发现没素材。
$frameFiles = @(Get-ChildItem $framesDir -Filter '*.png' -EA SilentlyContinue)
Write-Output "画布帧: $($frameFiles.Count) 张  合计 $([math]::Round((($frameFiles | Measure-Object Length -Sum).Sum)/1MB,2)) MB"
if ($frameFiles.Count -eq 0) {
  Write-Output '警告：没有抓到任何画布帧 —— getCurrentRenderedAreaImage 可能不可用（beta 接口）'
} else {
  $frameFiles | Select-Object -First 3 | ForEach-Object { Write-Output "  $($_.Name)  $($_.Length)B" }
}
Write-Output ''
if (-not (Test-Passed $raw)) { Write-Output '警告：本次 DRC 未通过，画面可能包含失败流程' }
if (Test-Path $OutFile) {
  Write-Output "录制完成: $OutFile ($([math]::Round((Get-Item $OutFile).Length/1MB,2)) MB)"
  & $ffprobe -v error -show_entries format=duration -show_entries stream=width,height,r_frame_rate -of default=noprint_wrappers=1 $OutFile 2>&1 | Out-String | Write-Output
} else { Write-Output '录制失败'; exit 1 }
