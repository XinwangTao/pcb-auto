<#
.SYNOPSIS
  短视频配 BGM（V6 标准配方）+ 可选上传到飞书群。

.DESCRIPTION
  输入任意一个 1080x1920/30fps 的 .mp4，输出「配好 BGM 的成片」，并能把成片发到飞书群。

  【V6 已验证的 BGM 配方 —— 参数不可改】
    BGM 源： F:\projects\remotion-tiktok\build\douyin_audio.m4a   (130.166s)
    滤镜链（顺序不能变）：
      highpass=f=70,
      equalizer=f=900:g=+7,
      equalizer=f=2400:g=+6,
      equalizer=f=4200:g=+4,
      equalizer=f=120:g=-1,
      afade=t=in:d=1.5,
      afade=t=out:d=2.5,
      loudnorm=I=-19:TP=-1.5:LRA=8
    BGM 混入音量： volume=0.78
    BGM 循环/裁切到与视频等长。

    ⚠ 关于 afade=t=out:d=2.5 的一处必要修正（唯一偏离字面配方的地方）：
      afade 的 st 缺省是 0，不显式给 st 时它是「从 0 秒开始淡出 2.5s，然后整段静音」，
      不是「最后 2.5s 淡出」。实测这版成片 RMS=-32.7dB、AAC 只剩 25kbps、2.5s 之后
      全是数字静音（分段 RMS -99dB），等于 BGM 有 88% 时长是哑的。
      所以本脚本默认把 st 锚到 (视频时长 - 2.5)，即真正的片尾淡出；其余滤镜参数、
      顺序、loudnorm/volume 数值全部与配方逐字一致。-LiteralFade 可切回字面原串做 A/B。

  【为什么原片音轨整条丢弃】
    V6 的成片是「无声操作录屏 + BGM 作为唯一音源」。原片（Remotion 渲染）自带的
    aac 音轨里只有静音/占位音，响度极低且会污染 loudnorm 之后的整体电平，因此本脚本
    **不做混音**，只 `-map 0:v:0` 取视频流，原音轨不进入输出（等价于对原音轨 -an）。
    如果哪天需要「保留原声 + 叠 BGM」，那是另一套配方（adelay+amix 并单独压原声），
    请新建脚本，不要改这里的 V6 配方。

  【成片硬规格】
    1080x1920 / 30fps / H.264 / pix_fmt=yuv420p / color_range=tv / AAC 48kHz 2ch
    视频流直接复制（-c:v copy），只重编码音频 —— 避免二次压缩丢画质。
    因此输入视频必须本来就满足上面的视频规格；不满足会直接报错（exit 3），
    而不是偷偷重编码。

.PARAMETER Path
  输入视频（.mp4）。别名 -Input / -Video / -Src 也能用。

.PARAMETER Output
  成片输出路径。默认 <输入目录>\<输入名>-bgm.mp4

.PARAMETER Bgm
  BGM 源文件。默认 V6 的 douyin_audio.m4a。

.PARAMETER Upload
  真正执行上传到飞书群。不加这个开关就只做本地混音 + 校验（默认不发任何东西）。

.PARAMETER DryRun
  只把上传步骤打印出来，不发送。可与 -Upload 同用（-DryRun 优先）。

.PARAMETER ShipOnly
  跳过混音，直接把 -Path 指定的现成文件按上传流程处理（成片定稿后单独补发时用）。

.PARAMETER LiteralFade
  逐字使用 afade=t=out:d=2.5（st=0，从开头淡出、之后静音），仅用于跟旧版做 A/B 对比。
  默认不加，默认把淡出锚在片尾最后 2.5s —— 见脚本头部关于 afade 的实测说明。

.PARAMETER Cover
  可选封面图（.png）。飞书 media 消息带 image_key 才能正常显示缩略图；
  不传封面也能发，但客户端可能提示「该消息类型暂不支持」。

.PARAMETER MaxUploadMB
  飞书单文件上限（MiB）。默认 43.6 —— 实测 45,726,598 B(43.61 MiB) 的 v6 原片
  上传必失败（code 234006），而 9.34 MiB 的分享版可成功。

.EXAMPLE
  # 只出成片，不发送
  pwsh -File video\mix-and-ship.ps1 -Path video\out\v7-placeholder.mp4

.EXAMPLE
  # 排练上传（打印请求，不真发）
  pwsh -File video\mix-and-ship.ps1 -Path video\out\v7-placeholder.mp4 -Upload -DryRun

.EXAMPLE
  # 成片定稿后真发
  pwsh -File video\mix-and-ship.ps1 -Path video\out\v7-bgm.mp4 -ShipOnly -Upload -Cover _cover.jpg

.NOTES
  退出码： 0 成功
           2 前置条件失败（pwsh 版本 / ffmpeg 工具 / 输入或 BGM 文件不存在）
           3 规格校验失败（输入不合规，或成片校验不过）
           4 ffmpeg 编码失败
           5 上传体积超限（> MaxUploadMB）
           6 飞书接口失败
           1 其他未预期错误
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [Alias('Input', 'Video', 'Src')]
  [string]$Path,

  [string]$Output,

  [string]$Bgm = 'F:\projects\remotion-tiktok\build\douyin_audio.m4a',

  [switch]$Upload,
  [switch]$DryRun,
  [switch]$ShipOnly,
  [switch]$LiteralFade,

  [string]$Cover,
  [string]$Title = 'AI 全自动设计 PCB',

  [double]$MaxUploadMB = 43.6,

  # 飞书自建应用凭据 —— **绝不硬编码**。
  #
  # 这个文件是入库的，写死 app_secret 等于把它发布到 GitHub 上（历史里也会有）。
  # 从环境变量读，没有就让飞书那一段明确失败，而不是拿一个默认值去连。
  #
  #   $env:FEISHU_APP_ID     = 'cli_...'
  #   $env:FEISHU_APP_SECRET = '...'
  #   $env:FEISHU_CHAT_ID    = 'oc_...'
  [string]$AppId = $env:FEISHU_APP_ID,
  [string]$AppSecret = $env:FEISHU_APP_SECRET,
  [string]$ChatId = $env:FEISHU_CHAT_ID
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- 常量

# ffmpeg / ffprobe：不再写死某个开发者本机的安装目录。
# 先看环境变量，再看 PATH；都不中就在下面的「前置条件」里 Stop-With 2 明确报错。
$Ffmpeg = $env:PCB_AUTO_FFMPEG
if (-not $Ffmpeg) {
  $c = Get-Command ffmpeg -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { $Ffmpeg = $c.Source }
}
$Ffprobe = $env:PCB_AUTO_FFPROBE
if (-not $Ffprobe) {
  $c = Get-Command ffprobe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { $Ffprobe = $c.Source }
}
$Inv = [System.Globalization.CultureInfo]::InvariantCulture

# V6 滤镜链：每一段都必须是单引号字面量，绝不能让它被 PowerShell 展开。
# 其中的逗号是 ffmpeg filtergraph 的分隔符，调用时整个字符串作为【单个参数】传给
# -filter_complex（用参数数组 @() 而不是拼接命令行字符串），Windows 上才不会断错。
# 各段顺序 = V6 配方顺序，下面再按顺序 join，顺序不可调换。
$V6ChainHead = 'highpass=f=70,equalizer=f=900:g=+7,equalizer=f=2400:g=+6,equalizer=f=4200:g=+4,equalizer=f=120:g=-1'
$V6FadeIn = 'afade=t=in:d=1.5'
$V6FadeOut = 'afade=t=out:d=2.5'
$V6Loudnorm = 'loudnorm=I=-19:TP=-1.5:LRA=8'
$V6Volume = 'volume=0.78'

# ⚠ afade=t=out:d=2.5 的 st 缺省值是 0：不给 st，它就从【开头】淡出 2.5s 然后一直静音。
#   实测（v7 素材，21.033s）：整条链跑到 afade 前 RMS=-16.1dB，加了不含 st 的 afade 后
#   RMS=-37.0dB、成片 RMS=-32.7dB、AAC 码率只剩 25kbps —— 等于 BGM 有 88% 时长是哑的。
#   即使把 BGM 直接当文件输入（已知 duration=130.166s）也一样从 0 开始淡出，是 afade 本身
#   的行为，不是我们裁切顺序造成的。
#   所以默认把 st 锚到「片尾前 2.5s」，这才是配方想要的「最后 2.5 秒淡出」；
#   想要逐字复刻原始字符串（开头淡出、后段静音）就加 -LiteralFade 做 A/B。

# ---------------------------------------------------------------- 小工具

function Say([string]$m) { Write-Host $m }
function SayOk([string]$m) { Write-Host "[ OK ] $m" -ForegroundColor Green }
function SayInfo([string]$m) { Write-Host "[info] $m" -ForegroundColor Cyan }
function SayWarn([string]$m) { Write-Host "[warn] $m" -ForegroundColor Yellow }

function Stop-With([int]$code, [string]$m) {
  Write-Host "[FAIL] $m" -ForegroundColor Red
  exit $code
}

function Format-MB([long]$bytes) {
  return ('{0:N2} MiB' -f ($bytes / 1MB))
}

# ffprobe -> JSON -> ConvertFrom-Json（不靠正则啃文本）
function Get-MediaInfo([string]$file) {
  $raw = & $Ffprobe -v error -of json -show_streams -show_format -- $file 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    Stop-With 3 "ffprobe 读不出这个文件（不是有效视频，或文件损坏）：$file`n$raw"
  }
  try { return ($raw | ConvertFrom-Json) }
  catch { Stop-With 3 "ffprobe 输出无法解析为 JSON：$file" }
}

# 视频流时长：优先 stream.duration，退化到 nb_frames/fps，再退化到 container duration
function Get-VideoDuration($info, $v) {
  $d = 0.0
  if ($null -ne $v.duration) { [void][double]::TryParse([string]$v.duration, [System.Globalization.NumberStyles]::Float, $Inv, [ref]$d) }
  if ($d -le 0 -and $v.nb_frames -and $v.r_frame_rate -match '^(\d+)/(\d+)$') {
    $num = [double]$Matches[1]; $den = [double]$Matches[2]
    if ($den -gt 0) { $d = [double]$v.nb_frames * ($den / $num) }
  }
  if ($d -le 0 -and $info.format.duration) { $d = [double]$info.format.duration }
  return $d
}

# 成片整体响度（EBU R128 积分响度）。
function Get-IntegratedLufs([string]$file) {
  $out = & $Ffmpeg -hide_banner -nostdin -i $file -map 0:a:0 -af 'ebur128=framelog=quiet' -f null NUL 2>&1 | Out-String
  $m = [regex]::Match($out, 'I:\s*(-?\d+(?:\.\d+)?)\s*LUFS')
  if (-not $m.Success) { return $null }
  return [double]::Parse($m.Groups[1].Value, $Inv)
}

# 某一段的 RMS（dB）。用来证明 BGM 在整条片子上都存在，而不是只有开头有声音。
# 必须分段量：EBU R128 的积分响度有 relative gate，中段静音的片子照样能凑到 -21 LUFS
# （实测「afade 从 0 淡出」那版 I=-20.8 LUFS 看起来完全正常，但 RMS 只有 -32.7dB、
#  AAC 码率 25kbps —— 只看 LUFS 会漏掉这种「88% 时长没声音」的坏片）。
function Get-SegmentRms([string]$file, [double]$from, [double]$to) {
  $span = [math]::Max(0.2, $to - $from)
  $ffa = @(
    '-hide_banner', '-nostdin', '-ss', $from.ToString('0.000', $Inv), '-i', $file,
    '-t', $span.ToString('0.000', $Inv), '-map', '0:a:0', '-af', 'astats', '-f', 'null', 'NUL'
  )
  $out = & $Ffmpeg @ffa 2>&1 | Out-String
  $ms = [regex]::Matches($out, 'RMS level dB:\s*(-?\d+(?:\.\d+)?|-inf)')
  if ($ms.Count -eq 0) { return $null }
  $last = $ms[$ms.Count - 1].Groups[1].Value
  if ($last -eq '-inf') { return -99.0 }
  return [double]::Parse($last, $Inv)
}

# ---------------------------------------------------------------- 1. 前置条件

if ($PSVersionTable.PSVersion.Major -lt 7) {
  Stop-With 2 "必须用 pwsh 7 运行（当前 Windows PowerShell $($PSVersionTable.PSVersion)）。5.1 会因中文编码把参数传坏。请用 pwsh -File 调用。"
}

foreach ($tool in @(@{ name = 'ffmpeg'; path = $Ffmpeg }, @{ name = 'ffprobe'; path = $Ffprobe })) {
  if (-not $tool.path -or -not (Test-Path -LiteralPath $tool.path -PathType Leaf)) {
    Stop-With 2 "找不到 $($tool.name)。装好 ffmpeg 套件并确保它在 PATH 上，或设置 `$env:PCB_AUTO_FFMPEG / `$env:PCB_AUTO_FFPROBE 指向对应的 exe。"
  }
}

$InFile = (Resolve-Path -LiteralPath $Path -ErrorAction SilentlyContinue)
if (-not $InFile) { Stop-With 2 "输入视频不存在：$Path" }
$InFile = $InFile.Path
if (-not (Test-Path -LiteralPath $InFile -PathType Leaf)) { Stop-With 2 "输入路径不是文件：$InFile" }

if (-not $ShipOnly) {
  # BGM 不存在就明确报错，绝不静默降级成「无 BGM 出片」
  if (-not (Test-Path -LiteralPath $Bgm -PathType Leaf)) {
    Stop-With 2 "BGM 源文件不存在：$Bgm`nV6 配方要求这个文件，本脚本不做静默降级（不会出一版没 BGM 的成片糊弄过去）。"
  }
}

if ($Cover -and -not (Test-Path -LiteralPath $Cover -PathType Leaf)) {
  Stop-With 2 "封面文件不存在：$Cover"
}

# ---------------------------------------------------------------- 2. 探输入

Say ''
Say '=== 1/4 探测输入 ==='

$inInfo = Get-MediaInfo $InFile
$inVideo = $inInfo.streams | Where-Object { $_.codec_type -eq 'video' } | Select-Object -First 1
if (-not $inVideo) { Stop-With 3 "输入里没有视频流：$InFile" }

$inDur = Get-VideoDuration $inInfo $inVideo
if ($inDur -le 0) { Stop-With 3 "读不到输入视频时长：$InFile" }

$inSize = (Get-Item -LiteralPath $InFile).Length
SayInfo "输入：$InFile"
SayInfo ("       {0}  |  {1}  |  {2}x{3}  |  {4}  |  {5}  |  {6:N3}s" -f (Format-MB $inSize), $inVideo.codec_name, $inVideo.width, $inVideo.height, $inVideo.pix_fmt, $inVideo.r_frame_rate, $inDur)

if (-not $ShipOnly) {
  # 视频流要 -c:v copy，所以输出规格 = 输入规格。输入不合规就只能报错，
  # 偷偷重编码会二次损失画质（违反「只重编码音频」的硬要求）。
  $bad = New-Object System.Collections.Generic.List[string]
  if ($inVideo.codec_name -ne 'h264') { $bad.Add("codec_name=$($inVideo.codec_name)，要求 h264") }
  if ([int]$inVideo.width -ne 1080) { $bad.Add("width=$($inVideo.width)，要求 1080") }
  if ([int]$inVideo.height -ne 1920) { $bad.Add("height=$($inVideo.height)，要求 1920") }
  if ($inVideo.pix_fmt -ne 'yuv420p') { $bad.Add("pix_fmt=$($inVideo.pix_fmt)，要求 yuv420p") }
  if ($inVideo.color_range -ne 'tv') { $bad.Add("color_range=$($inVideo.color_range)，要求 tv") }
  if ($inVideo.r_frame_rate -ne '30/1') { $bad.Add("r_frame_rate=$($inVideo.r_frame_rate)，要求 30/1") }
  if ($inVideo.sample_aspect_ratio -and $inVideo.sample_aspect_ratio -ne '1:1') { $bad.Add("sample_aspect_ratio=$($inVideo.sample_aspect_ratio)，要求 1:1") }

  if ($bad.Count -gt 0) {
    Stop-With 3 ("输入视频不满足成片硬规格，而视频流是 -c:v copy 直通的，改不了：`n  - " + ($bad -join "`n  - ") + "`n请让上游（remotion 渲染）按 1080x1920/30fps/yuv420p/tv/h264 出片后再跑本脚本。")
  }
  SayOk '输入视频规格合规（可直接 -c:v copy）'

  # 原片音轨存在也不混：V6 是「BGM 为唯一音源」，原音轨整条丢弃（见头部说明）。
  $inAudio = $inInfo.streams | Where-Object { $_.codec_type -eq 'audio' } | Select-Object -First 1
  if ($inAudio) {
    SayInfo "原片带 $($inAudio.codec_name)/$($inAudio.sample_rate)Hz/$($inAudio.channels)ch 音轨 → 按 V6 配方整条丢弃，只保留视频流"
  } else {
    SayInfo '原片无音轨'
  }

  $bgmInfo = Get-MediaInfo $Bgm
  $bgmStream = $bgmInfo.streams | Where-Object { $_.codec_type -eq 'audio' } | Select-Object -First 1
  if (-not $bgmStream) { Stop-With 2 "BGM 里没有音频流：$Bgm" }
  $bgmDur = [double]$bgmInfo.format.duration
  SayInfo ("BGM ：{0}  {1}  {2}Hz  {3}ch  {4:N3}s" -f (Format-MB ((Get-Item -LiteralPath $Bgm).Length)), $bgmStream.codec_name, $bgmStream.sample_rate, $bgmStream.channels, $bgmDur)
  if ($bgmDur -lt $inDur) {
    SayInfo ("      BGM 比视频短 {0:N2}s → 用 -stream_loop -1 循环，再 atrim 裁到视频长度" -f ($inDur - $bgmDur))
  }
}

# ---------------------------------------------------------------- 3. 混音

if (-not $Output) {
  $dir = Split-Path -Parent $InFile
  $base = [System.IO.Path]::GetFileNameWithoutExtension($InFile)
  $Output = Join-Path $dir "$base-bgm.mp4"
}
$OutFile = [System.IO.Path]::GetFullPath($Output)
$OutTmp = [System.IO.Path]::ChangeExtension($OutFile, '.tmp.mp4')

if ($ShipOnly) {
  $OutFile = $InFile
  Say ''
  Say '=== 2/4 混音 ==='
  SayInfo "已指定 -ShipOnly，跳过混音，直接处理现成文件：$OutFile"
} else {
  Say ''
  Say '=== 2/4 混音（-c:v copy，只重编码音频）==='

  $durStr = $inDur.ToString('0.000000', $Inv)   # 必须用 InvariantCulture，否则 zh-CN 会输出 "21,033333" 把滤镜吃坏

  # 淡出锚点 = 片尾前 2.5s。-LiteralFade 时退回原始字符串（st=0 → 开头淡出，后段静音）。
  $fadeSt = [math]::Max(0.0, $inDur - 2.5)
  if ($LiteralFade) {
    $fadeFilter = $V6FadeOut
    SayWarn '按 -LiteralFade 执行：afade 的 st 缺省为 0，BGM 在 2.5s 后基本静音（仅用于与旧版 A/B 对比）'
  } else {
    $fadeFilter = "afade=t=out:st=$($fadeSt.ToString('0.000000', $Inv)):d=2.5"
  }
  $V6Chain = @($V6ChainHead, $V6FadeIn, $fadeFilter, $V6Loudnorm) -join ','

  # atrim 裁到视频流时长：-stream_loop -1 进来的 BGM 是无限长，必须先截断，
  # 否则「与视频等长」无从谈起。aresample 链首/链尾把 HE-AACv2 解码后的采样率
  # 钉在 48k（loudnorm 内部按 192k 处理）。
  $filter = "[1:a:0]atrim=start=0:end=$durStr,asetpts=N/SR/TB,aresample=48000,$V6Chain,$V6Volume,aresample=48000[aout]"

  SayInfo "滤镜链：$V6Chain"
  SayInfo "音量  ：$V6Volume"
  SayInfo "裁切  ：atrim end=$durStr（与视频流等长）"
  SayInfo "输出  ：$OutFile"

  if (Test-Path -LiteralPath $OutTmp) { Remove-Item -LiteralPath $OutTmp -Force }

  # 用参数数组传给 ffmpeg：滤镜串里的逗号/冒号原样作为单个 argv，不会被 PowerShell 拆散
  $ffArgs = @(
    '-hide_banner', '-nostdin', '-y', '-loglevel', 'warning', '-stats'
    '-i', $InFile
    '-stream_loop', '-1', '-i', $Bgm
    '-filter_complex', $filter
    '-map', '0:v:0'          # 只取视频流：原片音轨不参与，等于对原音轨 -an
    '-map', '[aout]'
    '-c:v', 'copy'           # 视频直通，不二次压缩
    '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '192k', '-ar', '48000', '-ac', '2'
    '-shortest'
    '-movflags', '+faststart'
    $OutTmp
  )

  & $Ffmpeg @ffArgs
  if ($LASTEXITCODE -ne 0) { Stop-With 4 "ffmpeg 编码失败（exit $LASTEXITCODE），见上方 stderr。未产出成片。" }

  if (-not (Test-Path -LiteralPath $OutTmp)) { Stop-With 4 'ffmpeg 报成功但没有产出文件。' }

  # 先写 .tmp 再换名：中途失败不会留下一个看着像成片的半截文件
  Move-Item -LiteralPath $OutTmp -Destination $OutFile -Force
  SayOk "混音完成：$OutFile"
}

# ---------------------------------------------------------------- 4. 独立校验成片

Say ''
Say '=== 3/4 用 ffprobe 独立校验成片 ==='

$outInfo = Get-MediaInfo $OutFile
$ov = $outInfo.streams | Where-Object { $_.codec_type -eq 'video' } | Select-Object -First 1
$oa = $outInfo.streams | Where-Object { $_.codec_type -eq 'audio' } | Select-Object -First 1

$fail = New-Object System.Collections.Generic.List[string]
if (-not $ov) { $fail.Add('成片没有视频流') }
if (-not $oa) { $fail.Add('成片没有音频流') }
if ($oa -and @($outInfo.streams | Where-Object { $_.codec_type -eq 'audio' }).Count -ne 1) {
  $fail.Add("音频流数量=$(@($outInfo.streams | Where-Object { $_.codec_type -eq 'audio' }).Count)，要求恰好 1 条 BGM")
}

if ($ov) {
  if ($ov.codec_name -ne 'h264') { $fail.Add("codec_name=$($ov.codec_name)") }
  if ([int]$ov.width -ne 1080) { $fail.Add("width=$($ov.width)") }
  if ([int]$ov.height -ne 1920) { $fail.Add("height=$($ov.height)") }
  if ($ov.pix_fmt -ne 'yuv420p') { $fail.Add("pix_fmt=$($ov.pix_fmt)") }
  if ($ov.color_range -ne 'tv') { $fail.Add("color_range=$($ov.color_range)") }
  if ($ov.r_frame_rate -ne '30/1') { $fail.Add("r_frame_rate=$($ov.r_frame_rate)") }
  if ($ov.codec_tag_string -ne 'avc1') { $fail.Add("codec_tag=$($ov.codec_tag_string)") }
}
if ($oa) {
  if ($oa.codec_name -ne 'aac') { $fail.Add("audio codec=$($oa.codec_name)") }
  if ([int]$oa.sample_rate -ne 48000) { $fail.Add("audio sample_rate=$($oa.sample_rate)") }
  if ([int]$oa.channels -ne 2) { $fail.Add("audio channels=$($oa.channels)") }
}

$outDur = [double]$outInfo.format.duration
$durDelta = [math]::Abs($outDur - $inDur)
if ($durDelta -gt 0.2) { $fail.Add(("时长偏差 {0:N3}s（成片 {1:N3}s vs 输入 {2:N3}s，上限 0.2s）" -f $durDelta, $outDur, $inDur)) }

# 响度闸门：配方目标 -19 LUFS，乘 volume=0.78(-2.15dB) 后约 -21.15 LUFS。
$lufs = Get-IntegratedLufs $OutFile
if ($null -eq $lufs) {
  $fail.Add('量不出成片响度（ebur128 无输出），无法确认 BGM 是否真的存在')
} elseif ($lufs -lt -24 -or $lufs -gt -17) {
  $fail.Add(("成片积分响度 {0:N1} LUFS 不在 [-24, -17]（配方预期约 -21.1）：BGM 可能过轻" -f $lufs))
}

# BGM 存在性闸门：在片子的 15%~30%、40%~55%、75%~90% 各量一段 RMS，
# 任何一段塌到 -50dB 以下、或比最响那段低 12dB 以上，就说明 BGM 中途哑了。
$segWin = @(@(0.15, 0.30), @(0.40, 0.55), @(0.75, 0.90))
$segRms = New-Object System.Collections.Generic.List[double]
$segTxt = New-Object System.Collections.Generic.List[string]
foreach ($w in $segWin) {
  $s = $outDur * $w[0]; $e = $outDur * $w[1]
  $r = Get-SegmentRms $OutFile $s $e
  if ($null -ne $r) { $segRms.Add($r); $segTxt.Add(("{0:N1}~{1:N1}s:{2:N1}dB" -f $s, $e, $r)) }
}
$segSummary = $segTxt -join '  '
if ($segRms.Count -lt 3) {
  $fail.Add('量不出成片分段 RMS，无法确认 BGM 是否贯穿全片')
} else {
  $loudest = ($segRms | Measure-Object -Maximum).Maximum
  foreach ($i in 0..2) {
    if ($segRms[$i] -lt -50) {
      $fail.Add(("第 {0} 段 RMS {1:N1}dB 接近静音（{2}）：BGM 没有贯穿全片" -f ($i + 1), $segRms[$i], $segSummary))
    } elseif ($loudest - $segRms[$i] -gt 12) {
      $fail.Add(("第 {0} 段 RMS 比最响段低 {1:N1}dB（{2}）：BGM 中途变哑/淡出位置不对" -f ($i + 1), ($loudest - $segRms[$i]), $segSummary))
    }
  }
}

SayInfo ("成片：{0}  |  {1}" -f (Format-MB ((Get-Item -LiteralPath $OutFile).Length)), $OutFile)
Say ''
Say '  ffprobe 关键字段：'
Say ("    video.codec_name       = {0}" -f $ov.codec_name)
Say ("    video.width x height   = {0} x {1}" -f $ov.width, $ov.height)
Say ("    video.pix_fmt          = {0}" -f $ov.pix_fmt)
Say ("    video.color_range      = {0}" -f $ov.color_range)
Say ("    video.r_frame_rate     = {0}   (avg {1})" -f $ov.r_frame_rate, $ov.avg_frame_rate)
Say ("    video.nb_frames        = {0}" -f $ov.nb_frames)
Say ("    video.codec_tag_string = {0}" -f $ov.codec_tag_string)
Say ("    audio.codec_name       = {0} / {1}" -f $oa.codec_name, $oa.profile)
Say ("    audio.sample_rate      = {0} Hz" -f $oa.sample_rate)
Say ("    audio.channels         = {0} ({1})" -f $oa.channels, $oa.channel_layout)
Say ("    audio.bit_rate         = {0} bps" -f $oa.bit_rate)
Say ("    format.duration        = {0} s  (输入 {1} s, 偏差 {2:N3}s)" -f $outInfo.format.duration, $inDur, $durDelta)
Say ("    audio.integrated_loud   = {0} LUFS  (配方预期约 -21.1)" -f $(if ($null -eq $lufs) { 'N/A' } else { $lufs.ToString('N1', $Inv) }))
Say ("    audio.segment_rms       = {0}" -f $segSummary)
Say ''

if ($fail.Count -gt 0) {
  Stop-With 3 ("成片校验不通过：`n  - " + ($fail -join "`n  - ") + "`n文件保留在 $OutFile 供排查，但不要拿去发布。")
}
SayOk '成片全部规格校验通过'

# ---------------------------------------------------------------- 5. 上传飞书

Say ''
Say '=== 4/4 上传飞书 ==='

$outBytes = (Get-Item -LiteralPath $OutFile).Length
$limitBytes = [long][math]::Floor($MaxUploadMB * 1MB)

if (-not $Upload) {
  SayInfo '未指定 -Upload，本次不上传。'
  SayInfo "复核后要发的话：pwsh -File video\mix-and-ship.ps1 -Path `"$OutFile`" -ShipOnly -Upload [-Cover _cover.jpg]"
  Say ''
  SayOk "完成：$OutFile"
  exit 0
}

# 体积闸门：飞书单文件超限会返回 code 234006，硬传只是浪费一次失败。
if ($outBytes -gt $limitBytes) {
  $msg = @(
    "成片 $([System.IO.Path]::GetFileName($OutFile)) 有 $(Format-MB $outBytes)，超过飞书单文件上限 $(Format-MB $limitBytes)（-MaxUploadMB $MaxUploadMB），上传必然返回 code 234006。本次不发送。"
    ''
    '压缩建议（任选）：'
    '  1) 降码率重出（画质损失可控）：'
    '     ffmpeg -y -i "' + $OutFile + '" -c:v libx264 -crf 26 -preset medium -pix_fmt yuv420p -color_range tv -c:a aac -b:a 128k -ar 48000 -ac 2 out-small.mp4'
    '  2) 缩分辨率到 720x1280： -vf "scale=720:-2:flags=lanczos"'
    '  3) 砍时长（单条 ≤ 45s 最稳），或拆成两段发'
    '  4) 走飞书云文档/网盘分享链接，不用 im/v1/files'
    ''
    '参考：9.34 MiB 的分享版实测能发成功；45,726,598 B(43.61 MiB) 的 v6 原片必失败。'
  ) -join "`n"
  Stop-With 5 $msg
}
SayOk "体积 $((Format-MB $outBytes)) ≤ 上限 $(Format-MB $limitBytes)，可以上传"

if ($DryRun) {
  Say ''
  Say '--- DRY RUN：以下请求只会打印，不会发出 ---'
  Say "POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"
  Say "     body: { app_id: '$AppId', app_secret: '***' }"
  if ($Cover) {
    Say "POST https://open.feishu.cn/open-apis/im/v1/images   (multipart)"
    Say "     image_type=message, image=$(Split-Path $Cover -Leaf)  → image_key"
  }
  Say "POST https://open.feishu.cn/open-apis/im/v1/files      (multipart)"
  Say "     file_type=mp4"
  Say "     file_name=$([System.IO.Path]::GetFileName($OutFile))"
  Say "     duration=$([int][math]::Round($outDur))"
  Say "     file=<$(Format-MB $outBytes)>  → file_key"
  Say "POST https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id"
  Say "     receive_id=$ChatId"
  Say "     msg_type=media"
  Say "     content={ file_key, duration }$([bool]$Cover ? ' + image_key' : '')"
  Say '--- DRY RUN 结束：未发送任何消息 ---'
  Say ''
  SayOk "完成（dry-run）：$OutFile"
  exit 0
}

if (-not $Cover) {
  SayWarn '没给 -Cover：飞书 media 消息缺 image_key 时客户端可能显示「该消息类型暂不支持」。定稿发布建议带上封面图。'
}

# 凭据检查放在**这里**（真正要发消息之前），不放参数默认值里。
# 理由：本地纯混流不该被飞书凭据挡住；而一旦走到这一步就明确失败，
# 不要等到上传了 40 MB 才在 token 接口上撞一个看不懂的鉴权错误。
$missing = @(
  if (-not $AppId) { '$env:FEISHU_APP_ID' }
  if (-not $AppSecret) { '$env:FEISHU_APP_SECRET' }
  if (-not $ChatId) { '$env:FEISHU_CHAT_ID' }
) -join ', '
if ($missing) {
  Stop-With 5 "飞书凭据缺失：$missing。本仓库不提供默认值 —— 硬编码的 app_secret 会随 git 历史一起泄露。"
}

# 与 _send_video.ps1 保持同一套 token / multipart 写法（那份是实测发成功过的）
try {
  $tokResp = Invoke-RestMethod -Uri 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' `
    -Method Post -ContentType 'application/json' `
    -Body (@{ app_id = $AppId; app_secret = $AppSecret } | ConvertTo-Json) -TimeoutSec 60
  if ($tokResp.code -ne 0 -or -not $tokResp.tenant_access_token) {
    Stop-With 6 "拿 tenant_access_token 失败：code=$($tokResp.code) msg=$($tokResp.msg)（app_id/app_secret 不对，或应用没开 im:message 权限）"
  }
  $headers = @{ Authorization = "Bearer $($tokResp.tenant_access_token)" }
  SayOk 'tenant_access_token 取得'

  $imageKey = $null
  if ($Cover) {
    $img = Invoke-RestMethod -Uri 'https://open.feishu.cn/open-apis/im/v1/images' -Method Post -Headers $headers `
      -Form @{ image_type = 'message'; image = Get-Item -LiteralPath $Cover } -TimeoutSec 120
    if ($img.code -ne 0) { Stop-With 6 "封面上传失败：code=$($img.code) msg=$($img.msg)" }
    $imageKey = $img.data.image_key
    SayOk "image_key=$imageKey"
  }

  $form = @{
    file_type = 'mp4'
    file_name = [System.IO.Path]::GetFileName($OutFile)
    duration  = "$([int][math]::Round($outDur))"
    file      = Get-Item -LiteralPath $OutFile
  }
  $up = Invoke-RestMethod -Uri 'https://open.feishu.cn/open-apis/im/v1/files' -Method Post -Headers $headers `
    -Form $form -TimeoutSec 900
  if ($up.code -eq 234006) {
    Stop-With 5 "飞书拒绝：文件超过上限（code 234006，$(Format-MB $outBytes)）。按上文压缩建议处理后重发。"
  }
  if ($up.code -ne 0) { Stop-With 6 "文件上传失败：code=$($up.code) msg=$($up.msg)" }
  $fileKey = $up.data.file_key
  SayOk "file_key=$fileKey"

  $content = @{ file_key = $fileKey; duration = [int][math]::Round($outDur) }
  if ($imageKey) { $content.image_key = $imageKey }

  $msgBody = @{
    receive_id = $ChatId
    msg_type   = 'media'
    content    = ($content | ConvertTo-Json -Compress)
  } | ConvertTo-Json -Compress

  $sent = Invoke-RestMethod -Uri 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id' `
    -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $msgBody -TimeoutSec 120
  if ($sent.code -ne 0) { Stop-With 6 "消息发送失败：code=$($sent.code) msg=$($sent.msg)" }

  SayOk "已发送到群 $ChatId，message_id=$($sent.data.message_id)"
  SayInfo "标题：$Title"
} catch {
  if ($_.Exception.Message -match 'Stop-With') { throw }
  Stop-With 6 "飞书接口调用异常：$($_.Exception.Message)"
}

Say ''
SayOk "完成：$OutFile"
exit 0
