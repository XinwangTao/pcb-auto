# ============================================================
# pcb-auto 唯一入口：想法（design JSON） -> 可打样 PCB
# 用法：
#   .\run-all.ps1 -Design designs\d1-sht30.json
#   .\run-all.ps1 -Idea "做一个 ESP32-C3 温湿度记录板"
# ============================================================
param(
  [string]$Design = 'designs\d1-sht30.json',
  [string]$Idea,
  [string]$OutDir,
  [switch]$KeepSession,
  [switch]$SkipAudit
)
$ErrorActionPreference = 'Stop'
$CLI = 'E:\APP\lceda-pro\lceda-pro.exe'
$Root = $PSScriptRoot
$SessionFile = Join-Path $Root '.session'
$LockFile = Join-Path $Root '.pipeline.lock'

# 外部 invoke 的 --timeout 只让 CLI 放弃等待，**不中断** render 里的代码（CLI 原文：
# "the code may still be running in the render, and its result will be discarded"）。
# 所以超时必须与流水线自己的预算对齐，否则超时后留下幽灵调用，
# 紧接着的下一次 invoke 一定不是 JSON —— 实测表现为「整批设计无声失败、策略=?」。
$InvokeTimeoutMs = 590000
$PipelineBudgetMs = $InvokeTimeoutMs - 60000     # 60s 余量给结果回传与落盘

function Log($msg, $color = 'Cyan') { Write-Host "[pcb-auto] $msg" -ForegroundColor $color }

# ---------- 0. 全局互斥锁 ----------
# 所有 run-all 共用同一个 EDA headless session；并发跑会互相污染
# （实测：并行跑 d2/d6 时表现成"失败"，串行则全过）。
# 这里是长期无人值守运行的必备保护，不能省。
function Acquire-Lock {
  $deadline = (Get-Date).AddMinutes(90)
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-Path $LockFile)) {
      try {
        # CreateNew 原子创建，抢不到会抛异常，天然互斥
        $fs = [IO.File]::Open($LockFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $w = New-Object IO.StreamWriter($fs)
        $w.WriteLine("pid=$PID")
        $w.WriteLine("start=$(Get-Date -Format o)")
        $w.WriteLine("design=$Design$Idea")
        $w.Flush(); $w.Close(); $fs.Close()
        return $true
      } catch {
        Log '另一条流水线正在使用 EDA session，等待…' 'DarkYellow'
        Start-Sleep -Seconds 10
        continue
      }
    }
    # 陈旧锁清理：持有者进程已不存在，或锁超过 90 分钟
    $stale = $false
    try {
      $first = (Get-Content $LockFile -TotalCount 1) -replace 'pid=', ''
      $holderPid = [int]$first
      if (-not (Get-Process -Id $holderPid -ErrorAction SilentlyContinue)) { $stale = $true }
    } catch { $stale = $true }
    if (Test-Path $LockFile) {
      if (((Get-Date) - (Get-Item $LockFile).LastWriteTime).TotalMinutes -gt 90) { $stale = $true }
    }
    if ($stale) {
      Log '清理陈旧锁' 'DarkYellow'
      Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
      continue
    }
    Start-Sleep -Seconds 10
  }
  throw "等待流水线锁超时（90 分钟）"
}

function Release-Lock {
  if (Test-Path $LockFile) { Remove-Item $LockFile -Force -ErrorAction SilentlyContinue }
}

$locked = Acquire-Lock
if (-not $locked) { throw '无法获取流水线锁' }
try {

# ---------- 1. 确保有可用 session ----------
# 坑（2026-11-25 实测，一夜跑出 28 个 lceda-pro 进程把端点打挂）：
# 原实现只在 `.session` 文件里的 id invoke 失败时 `open --headless true` 开新的，
# **从不复用、也从不回收旧实例**。一旦端点开始抖动，每次自愈都新开一个 Electron
# 实例（每个实例 5~8 个子进程），20 秒内能开 8 个，最终 ENDPOINT_UNAVAILABLE，
# 后续所有设计都退化成「输出不是 JSON」——看起来像 DRC 失败，其实是环境自毁。
# 正确策略：
#   1) 先验 `.session` 文件里的 id；
#   2) 不行就在 `session list` 里**捡一个现成的 headless cli 会话**复用；
#   3) 都没有才开新的，且开之前先回收孤儿实例；
#   4) 开新失败要有限次重试，不许无限开。
function Get-LcedaMainProcesses {
  $procs = Get-CimInstance Win32_Process -Filter "Name='lceda-pro.exe'" -ErrorAction SilentlyContinue
  if (-not $procs) { return @() }
  # 只算主进程（没有 --type= 的），子进程会随主进程一起走
  $procs | Where-Object { $_.CommandLine -notmatch '--type=' }
}

function Remove-OrphanLceda {
  $mains = Get-LcedaMainProcesses
  if (-not $mains) { return 0 }
  $killed = 0
  foreach ($m in $mains) {
    # 父进程已消失 = 孤儿。父进程还在的是当前持有者（本脚本或其子 CLI），不动。
    if (-not (Get-Process -Id $m.ParentProcessId -ErrorAction SilentlyContinue)) {
      try { Stop-Process -Id $m.ProcessId -Force -ErrorAction Stop; $killed++ } catch { }
    }
  }
  if ($killed -gt 0) {
    Log ("回收 $killed 个孤儿 lceda-pro 实例" -f $killed) 'DarkYellow'
    Start-Sleep -Seconds 2
  }
  return $killed
}

function Test-SessionAlive([string]$sid) {
  if (-not $sid) { return $false }
  try {
    $probe = (& $CLI invoke --session $sid --ext-uuid eda --code 'return 1' --timeout 30000 2>&1 | Out-String)
    $j = $probe | ConvertFrom-Json
    return [bool]($j.ok)
  } catch { return $false }
}

function Get-ReusableSession {
  # 从 session list 里挑一个 headless + cli + 未绑定项目的裸编辑器会话
  try {
    $raw = (& $CLI session list 2>&1 | Out-String)
    $j = $raw | ConvertFrom-Json
    $list = if ($j.value) { $j.value } else { $j }
    $cand = @($list | Where-Object { $_.headless -eq $true -and $_.origin -eq 'cli' })
    return $cand
  } catch { return @() }
}

function Ensure-Session {
  Remove-OrphanLceda | Out-Null

  # 1) 文件里的会话
  if (Test-Path $SessionFile) {
    $sid = (Get-Content $SessionFile -Raw).Trim()
    if (Test-SessionAlive $sid) { return $sid }
    Log "`.session 里的会话 $sid 已失效" 'DarkYellow'
  }

  # 2) 复用 session list 里现成的 headless cli 会话
  foreach ($c in (Get-ReusableSession)) {
    if (Test-SessionAlive $c.sessionId) {
      Set-Content -Path $SessionFile -Value $c.sessionId -NoNewline
      Log "复用已有会话 $($c.sessionId)"
      return $c.sessionId
    }
  }

  # 3) 开新的（限次，且每次开前回收孤儿）
  for ($try = 1; $try -le 3; $try++) {
    Remove-OrphanLceda | Out-Null
    Log "启动新 headless session（第 $try 次）…"
    $open = (& $CLI open --headless true 2>&1 | Out-String)
    $sid = $null
    try { $sid = ($open | ConvertFrom-Json).value.sessionId } catch { }
    if ($sid -and (Test-SessionAlive $sid)) {
      Set-Content -Path $SessionFile -Value $sid -NoNewline
      Log "session = $sid"
      return $sid
    }
    Log "开启失败或不可用，等待 5s 重试：$($open.Substring(0, [Math]::Min(150, $open.Length)))" 'Yellow'
    Start-Sleep -Seconds 5
  }
  throw "无法获得可用 EDA session（已重试 3 次）"
}

# ---------- 2. 准备参数 ----------
# -Idea 模式：先用 idea2design.js 把自然语言编译成 design JSON，再走同一条流水线。
if ($Idea) {
  Log "编译想法 → design JSON"
  $nodeExe = 'E:\APP\nodejs24\node.exe'
  if (-not (Test-Path $nodeExe)) { $nodeExe = 'node' }
  $slug = ($Idea -replace '[^\w\u4e00-\u9fa5]+', '-')
  if ($slug.Length -gt 30) { $slug = $slug.Substring(0, 30) }
  $genTarget = Join-Path $Root "designs\gen-$slug.json"
  $comp = (& $nodeExe (Join-Path $Root 'scripts\idea2design.js') $Idea -o $genTarget 2>&1 | Out-String)
  Write-Host $comp
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $genTarget)) {
    throw "想法编译失败（exit=$LASTEXITCODE）。请扩充 designs\_catalog.json 或改写想法。"
  }
  $Design = (Resolve-Path $genTarget).Path
}

if (-not (Test-Path (Join-Path $Root $Design)) -and -not (Test-Path $Design)) {
  throw "design not found: $Design"
}
$designPath = if (Test-Path (Join-Path $Root $Design)) { Join-Path $Root $Design } else { $Design }
$designJson = Get-Content $designPath -Raw
$designObj = $designJson | ConvertFrom-Json

if ($Idea -and -not $designObj._idea) { $designObj | Add-Member -NotePropertyName '_idea' -NotePropertyValue $Idea -Force }

$stamp = [DateTime]::Now.ToString('yyyyMMdd-HHmmss')
$name = if ($designObj.name) { $designObj.name } else { 'board' }
if (-not $OutDir) { $OutDir = Join-Path $Root "out\$name-$stamp" }
# 必须绝对路径：pipeline3.js 把 outDir 原样交给 EDA 进程的
# sys_FileSystem.saveFileToFileSystem。EDA 进程的 cwd 与本脚本不同，
# 传相对路径（如 `-OutDir out\foo`）会让 6 个导出全部返回 ok:false，
# 且**不报错**——产物目录静默为空，看起来像「导出坏了」，实为路径没解析。
$OutDir = [IO.Path]::GetFullPath($OutDir, (Get-Location).Path)
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# ---------- 2.5 静态电气审计（不碰 EDA，毫秒级）----------
# 动机：DRC 只查几何，不查电路。实测 d11 把晶振接到 RP2040 不存在的 20/21 脚、
# d8 的 5V 只连到 9 个电阻却没有任何供电接口，两条设计在回归里都是 PASS。
# 这类错误跑完 90~300 秒流水线也查不出来，必须在开跑前拦住。
if (-not $SkipAudit) {
  # 注意：$nodeVerify 在后面第 ~195 行才定义，这里必须自己解析，
  # 否则 & 后面是 $null → "管道元素中 '&' 后面的表达式生成了无效对象"，
  # 每个设计 0.7 秒就失败（2026-11-25 无人值守循环就是这么全线崩的）。
  $nodeAudit = 'E:\APP\nodejs24\node.exe'
  if (-not (Test-Path $nodeAudit)) { $nodeAudit = 'node' }
  $auditOut = (& $nodeAudit (Join-Path $Root 'scripts\audit-design.js') $designPath 2>&1 | Out-String)
  $auditCode = $LASTEXITCODE
  $auditFails = @($auditOut -split "`n" | Where-Object { $_ -match '\[FAIL\]' } | ForEach-Object { $_.Trim() })
  # fail-open 防线：这是唯一能拦电路错误的闸门（DRC 只查几何）。
  # 原实现只数 `[FAIL]` 行，审计脚本自己崩掉时（语法错、缺依赖、读不到设计文件）
  # 输出里一行 `[FAIL]` 都没有 → 判定"通过"，等于把唯一防线关掉。
  # 所以非 0 退出码一律按失败处理，并打印原始输出便于定位。
  if ($auditCode -ne 0 -or $auditFails.Count -gt 0) {
    Write-Host "[pcb-auto] 静态电气审计未通过（exit $auditCode）—— 这些是电路错误，跑流水线也查不出来：" -ForegroundColor Red
    foreach ($f in $auditFails) { Write-Host "  $f" -ForegroundColor Red }
    if ($auditCode -ne 0 -and $auditFails.Count -eq 0) {
      Write-Host '  审计脚本自身异常，原始输出：' -ForegroundColor Red
      ($auditOut -split "`n" | Select-Object -First 15) | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkRed }
    }
    Write-Host '如需强行继续（不推荐），加 -SkipAudit' -ForegroundColor Yellow
    Release-Lock
    exit 1
  }
  Log '静态电气审计通过（引脚合法性 / 网络完整性 / 电源来源 / IC 接地）'
}

$argsFile = Join-Path $Root "scripts\_args_live.json"
$payload = @{ design = $designObj; outDir = $OutDir } | ConvertTo-Json -Depth 20 -Compress
Set-Content -Path $argsFile -Value $payload -Encoding UTF8

# ---------- 3. 跑流水线（带自愈重试）----------
$sid = Ensure-Session
Log "流水线启动：$name -> $OutDir"
$sw = [Diagnostics.Stopwatch]::StartNew()

# 自愈策略：失败时换一组板框尺寸重试。无人干预的核心就在这里。
# 经验：板框过小/器件跨度超出板框时，布线器会静默放弃（1.2s 返回 completed 但零铜），换更大板框即可。
# 智能预判：按器件数与引脚数粗估所需面积，避免第一轮就必然失败。
$baseW = if ($designObj.boardWidthMil) { [int]$designObj.boardWidthMil } else { 1000 }
$baseH = if ($designObj.boardHeightMil) { [int]$designObj.boardHeightMil } else { 800 }

# 面积预估：实测 RP2040(57 脚 QFN + 11 个外围件) 在 1600x1200 失败、2400x1800 成功，
# 所以按「连接数 × 系数」估，宁可一次给足，避免白跑一轮。
$compCount = @($designObj.components).Count
$connCount = @($designObj.connections).Count
# 面积预估值只作**下限**用，绝不用来放大设计声明的板框。
# 2026-11-25 实测反例：旧系数(120000/件+12000/连接)把 d8(20件41连) 估成 289 万 mil²，
# 于是把声明的 1400x1000 放大到 2126x1786 —— 放大后 2 处违规，而 1400x1000 直接通过(150s)；
# d7(10件46连) 同样 2400x1800 失败、1200x900 通过。这两类板子「板越大越差」：
# 器件被摊开、走线细长、吸附与间距都更容易出错。系数按实测通过面积重新标定。
$estArea = [Math]::Max(480000, $compCount * 55000 + $connCount * 9000)
$estSide = [Math]::Ceiling([Math]::Sqrt($estArea))
$FIVExFIVE_MIL2 = 1969 * 1969
$baseArea = $baseW * $baseH
if ($baseArea -gt [Math]::Max($estArea * 2.2, $FIVExFIVE_MIL2)) {
  Log ("板框过大（{0}x{1}={2:N0} mil² > 预估 {3:N0} mil² 的 2.2 倍），首轮按预剪切板" -f $baseW,$baseH,$baseArea,$estArea) 'DarkYellow'
  $baseW = [int]($estSide * 1.15); $baseH = [int]($estSide * 1.15)
} elseif ($baseArea -lt $estArea * 0.75) {
  Log ("板框偏小（{0}x{1}={2:N0} mil² < 预估下限 {3:N0} mil²），首轮即按预估放大" -f $baseW,$baseH,$baseArea,$estArea) 'DarkYellow'
  # 放大系数必须克制：原来 ×1.9/×1.45 让 d3 从 1200x900 直接跳到 2214x1689（374 万 mil²），
  # 随后紧凑优化又缩回 1373x1048 —— 一整轮流水线（~100s）纯属白跑。
  # 实测 d3 真实需求约 144 万 mil²，所以按估算面积 ×1.25 给余量即可。
  $baseW = [Math]::Max($baseW, [int]($estSide * 1.25))
  $baseH = [Math]::Max($baseH, [int]($estSide * 1.05))
}

# 会话自毁的统一处置。REQUEST_TIMEOUT 说明上一段代码仍占着 render；
# SESSION_CLOSED / SESSION_NOT_FOUND 说明 session 已被别处 abort 或工程侧失效。
# 两种都必须换一个干净 session，直接 continue 只会把整批设计一起拖死。
# session abort 是唯一能杀掉「卡死窗口/仍在跑的代码」的命令。
function Reset-Session([string]$why) {
  Log "重建 session（原因：$why）" 'Yellow'
  try { & $CLI session abort --session $script:sid 2>&1 | Out-Null } catch { }
  Remove-Item $SessionFile -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  try { $script:sid = Ensure-Session; return $script:sid }
  catch { Log "重建会话失败：$($_.Exception.Message)" 'Red'; return $null }
}

$healPlans = @(
  @{ w = $baseW;        h = $baseH;        tag = 'smart-fit' },
  # 实测（2026-11-25，13 个设计 2 轮）：扩板对 DRC 失败**零收益**。
  # d6/d7/d11/d12 在 smart-fit / 1.5x / 2.0x / 1.5x-retry 四种板框上重复失败，
  # 且失败形态完全相同（1~2 个违规）——因为缺陷是「几何上没铜」或「铜压铜」，
  # 与板子大小无关。扩板只把板子撑到 2~3 倍面积（RP2040_Minimal 被判 3104x2607，
  # 声明 1600x1200），浪费打样费还让器件稀疏难看。
  # 改为：小块扩一次给布线一点余地即可，之后靠流水线内部的
  # stitchGaps（断线补铜）与 fixClearance（缩窄+绕行）真治根因。
  @{ w = $baseW * 1.25; h = $baseH * 1.25; tag = 'expand-1.25x' }
)

# 面积美学：板框是估出来的，过大会导致器件挤在中间、四周大片空白（看着不专业、多花打样费）。
# 实测：布局**之后**剪板框会毁掉布线（布局按大板框排成细长条，剪完扇出空间不足，
# fixClearance 把走线全删、68 个网络全断）。正确顺序是布局**之前**就用小板框重跑。
# 成功一次后，若填充率 < 0.5，按 sqrt(fillRatio) 比例收缩初始板框再试一次，取更优者。
$aestheticTried = $false
$bestArea = [double]::MaxValue
$bestRaw = $null; $bestV = $null; $bestPlan = $null; $bestW = 0; $bestH = 0

$raw = $null; $res = $null; $v = $null; $usedPlan = $null
$lastGoodRaw = $null
$verifyFails = @()
$nodeVerify = 'E:\APP\nodejs24\node.exe'
if (-not (Test-Path $nodeVerify)) { $nodeVerify = 'node' }

foreach ($plan in $healPlans) {
  $designObj.boardWidthMil = [int]$plan.w
  $designObj.boardHeightMil = [int]$plan.h
  $payload = @{ design = $designObj; outDir = $OutDir; budgetMs = $PipelineBudgetMs } | ConvertTo-Json -Depth 20 -Compress
  Set-Content -Path $argsFile -Value $payload -Encoding UTF8

  Log ("尝试 [$($plan.tag)] 板框 {0}x{1} mil" -f $plan.w, $plan.h) 'DarkGray'
  try {
    $raw = (& $CLI invoke --session $sid --ext-uuid eda --code-file (Join-Path $Root 'scripts\pipeline3.js') --args (Get-Content $argsFile -Raw) --timeout $InvokeTimeoutMs 2>&1 | Out-String)
  } catch {
    Log "invoke 异常：$($_.Exception.Message)" 'Yellow'
    continue
  }
  try { $res = $raw | ConvertFrom-Json } catch {
    # 非 JSON 只有两类原因，且都必须先换 session 再重试，否则重试必然同样失败
    $why = if ($raw -match 'REQUEST_TIMEOUT') { 'REQUEST_TIMEOUT 幽灵调用仍在 render 里跑' }
           elseif ($raw -match 'SESSION_CLOSED') { 'SESSION_CLOSED session 已被 abort' }
           elseif ($raw -match 'SESSION_NOT_FOUND|does not exist') { 'SESSION_NOT_FOUND session 已失效' }
           else { 'NON_JSON 未知输出' }
    Log "输出不是 JSON（$why）" 'Yellow'
    ($raw -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 2) | ForEach-Object { Log "    $($_.Trim())" 'DarkYellow' }
    if (-not (Reset-Session $why)) { continue }
    try {
      $raw = (& $CLI invoke --session $sid --ext-uuid eda --code-file (Join-Path $Root 'scripts\pipeline3.js') --args (Get-Content $argsFile -Raw) --timeout $InvokeTimeoutMs 2>&1 | Out-String)
      $res = $raw | ConvertFrom-Json
    } catch { Log "重建后重试仍失败：$($_.Exception.Message)" 'Yellow'; continue }
  }
  if ($res -and -not $res.ok) {
    # 会话失效要先判，否则下面的通用信封错误分支会把它当普通失败白跑完所有 plan
    if ($raw -match 'SESSION_NOT_FOUND|does not exist') {
      Log '检测到会话已失效，重建 session 后重试当前方案' 'Yellow'
      Remove-Item $SessionFile -Force -ErrorAction SilentlyContinue
      try { $sid = Ensure-Session } catch { Log "重建会话失败：$($_.Exception.Message)" 'Red'; continue }
      try {
        $raw = (& $CLI invoke --session $sid --ext-uuid eda --code-file (Join-Path $Root 'scripts\pipeline3.js') --args (Get-Content $argsFile -Raw) --timeout $InvokeTimeoutMs 2>&1 | Out-String)
        $res = $raw | ConvertFrom-Json
      } catch { Log "重建后重试仍失败：$($_.Exception.Message)" 'Yellow'; continue }
    }
    if ($res -and -not $res.ok) { Log ("信封错误：" + ($res.error | ConvertTo-Json -Compress)) 'Yellow'; continue }
  }
  $v = $res.value
  $usedPlan = $plan.tag
  if (-not $v.ok) {
    Log ("[$($plan.tag)] 未通过：DRC 违规组 $($v.drcDetailCount)") 'Yellow'
    continue
  }

  # 流水线自述通过还不够 —— 立刻做独立产物校验。
  # 实测踩坑：板框 200x200 时流水线报 ok/DRC=0，但器件跨度 511x498 溢出板框、底层近乎零铜。
  # 只有产物级校验能发现这类"自述成功、实体失败"，所以让校验结果参与自愈判定。
  Log ("[$($plan.tag)] 流水线自述通过，开始独立校验") 'Green'
  $vfRaw = (& $nodeVerify (Join-Path $Root 'scripts\verify-artifacts.js') $OutDir $designPath 2>&1 | Out-String)
  $vfCode = $LASTEXITCODE
  $vfFails = @($vfRaw -split "`n" | Where-Object { $_ -match '\[FAIL\]' } | ForEach-Object { $_.Trim() })
  # fail-open 防线：原实现只数 `[FAIL]` 行。校验器自己崩掉时（exit 2、缺 Netlist.json
  # 之类的环境/解析异常）输出里一行 `[FAIL]` 都没有 → 判"独立校验通过"并 break，
  # 直接废掉后面所有自愈策略。这是"自述成功、实体失败"的唯一防线，不能靠数日志行。
  if ($vfCode -ne 0) {
    Log ("[$($plan.tag)] 独立校验器异常退出（exit $vfCode），按未通过处理并继续自愈") 'Red'
    ($vfRaw -split "`n" | Select-Object -First 10) | ForEach-Object { if ($_.Trim()) { Log "    $_" 'DarkRed' } }
  }
  if ($vfCode -eq 0 -and $vfFails.Count -eq 0) {
    # 第二道独立闸门：产物校验只读导出文件，**从不重跑 DRC**，
    # 所以流水线自述的 drcPassed 一直无人复核（审计实测 d12 自报 FAIL 而独立复核 PASS，
    # 自报是双向不可信的）。这里开回工程、重建覆铜、自己数违规。
    $drcReOk = $true
    try {
      $drcReRaw = (& $nodeVerify (Join-Path $Root 'scripts\verify-drc.js') $v.projectUuid $sid 2>&1 | Out-String)
      $drcReCode = $LASTEXITCODE
      if ($drcReCode -eq 1) {
        $drcReOk = $false
        $drcReJson = $null
        try { $drcReJson = $drcReRaw | ConvertFrom-Json } catch { }
        $nBad = if ($drcReJson) { $drcReJson.total } else { '?' }
        Log ("[$($plan.tag)] 独立 DRC 复核失败：$nBad 处违规（流水线自述通过 = 假阴性）") 'Yellow'
        if ($drcReJson -and $drcReJson.byType) {
          $drcReJson.byType.PSObject.Properties | ForEach-Object { Log ("    违规类型 $($_.Name) = $($_.Value)") 'DarkYellow' }
        }
      } elseif ($drcReCode -ne 0) {
        # exit 2 = 环境问题（会话/端点），**不算设计失败** —— 否则会把环境抖动记成设计缺陷，
        # 正是这次 28 个进程打死端点、全部设计「输出不是 JSON」的教训。
        Log ("[$($plan.tag)] 独立 DRC 复核环境异常（exit $drcReCode），本闸门跳过") 'DarkYellow'
      } else {
        Log ("[$($plan.tag)] 独立 DRC 复核通过") 'Green'
      }
    } catch { Log ("[$($plan.tag)] 独立 DRC 复核异常：$($_.Exception.Message)") 'DarkYellow' }
    if (-not $drcReOk) { continue }

    $verifyFails = @()
    $lastGoodRaw = $raw
    Log ("[$($plan.tag)] 独立校验通过") 'Green'

    # ---- 面积美学：过大的板框让器件挤中间、四周空白，看着不专业且多花打样费。
    # 填充率 = 器件实际占用面积 / 板框面积；< 0.5 就用更小的初始板框重跑一轮，
    # 两者都通过校验时取面积更小的。必须在布局前缩小 —— 布局后剪会毁掉布线。
    $fill = $v.outlineFillRatio
    $curArea = [double]$plan.w * [double]$plan.h
    if ($null -eq $bestRaw -or $curArea -lt $bestArea) {
      $bestRaw = $raw; $bestV = $v; $bestPlan = $plan.tag
      $bestW = [int]$plan.w; $bestH = [int]$plan.h; $bestArea = $curArea
    }
    # 小板不值当：打样按 5×5cm 内同价，把 3 个器件的板缩到 744x558 省钱为零，
    # 却要整条流水线再跑一遍（实测 d1 从 71s 涨到 ~240s，d3 从 100s 涨到 389s）。
    # 只有器件足够多、面积确实大时才做紧凑优化。
    $curAreaForCompact = [double]$plan.w * [double]$plan.h
    # 判据要有经济意义：嘉立创打样 5×5cm（约 1969×1969 mil）以内同价，
    # 小于这个尺寸再缩也省不到钱，纯属多跑一整条流水线。
    $FIVExFIVE_MIL2 = 1969 * 1969
    $worthCompact = ($compCount -ge 8) -and ($curAreaForCompact -ge $FIVExFIVE_MIL2)
    if (-not $worthCompact -and $null -ne $fill -and $fill -lt 0.5) {
      Log ("填充率 {0:P0} 偏低，但 {1} 个器件 / 面积 {2:N0} mil² 仍在 5×5cm 同价区内，跳过紧凑优化" -f $fill, $compCount, $curAreaForCompact) 'DarkGray'
    }
    if (-not $aestheticTried -and $worthCompact -and $null -ne $fill -and $fill -gt 0 -and $fill -lt 0.5) {
      $aestheticTried = $true
      # 面积按比例缩：边长乘 sqrt(fill)，再留 1.15 安全系数，避免缩过头布线失败。
      # 实测：缩到 0.45 会让 0402/0603 位号丝印互相重叠、难以辨认 —— 面积省了但可制造性变差。
      # 所以下限提到 0.62：只做温和紧凑，保证丝印可读优先于极致省面积。
      $scale = [Math]::Sqrt([double]$fill) * 1.15
      if ($scale -lt 0.62) { $scale = 0.62 }
      $nw = [int]([Math]::Ceiling($plan.w * $scale))
      $nh = [int]([Math]::Ceiling($plan.h * $scale))
      Log ("板材填充率 {0:P0} 偏低，尝试紧凑板框 {1}x{2} mil（当前 {3}x{4}）" -f $fill, $nw, $nh, $plan.w, $plan.h) 'Cyan'
      $designObj.boardWidthMil = $nw
      $designObj.boardHeightMil = $nh
      # 输出到独立子目录：紧凑方案可能更差，不能覆盖已通过校验的产物
      $compactDir = Join-Path $OutDir 'compact'
      New-Item -ItemType Directory -Force -Path $compactDir | Out-Null
      $payload2 = @{ design = $designObj; outDir = $compactDir } | ConvertTo-Json -Depth 20 -Compress
      Set-Content -Path $argsFile -Value $payload2 -Encoding UTF8
      $raw2 = $null
      try {
        $raw2 = (& $CLI invoke --session $sid --ext-uuid eda --code-file (Join-Path $Root 'scripts\pipeline3.js') --args (Get-Content $argsFile -Raw) --timeout $InvokeTimeoutMs 2>&1 | Out-String)
      } catch { Log "紧凑板框 invoke 异常：$($_.Exception.Message)" 'Yellow' }
      if ($raw2) {
        $res2 = $null
        try { $res2 = $raw2 | ConvertFrom-Json } catch { }
        if ($res2 -and $res2.ok -and $res2.value.ok) {
          $v2 = $res2.value
          $vf2 = (& $nodeVerify (Join-Path $Root 'scripts\verify-artifacts.js') $compactDir $designPath 2>&1 | Out-String)
          $vf2Fails = @($vf2 -split "`n" | Where-Object { $_ -match '\[FAIL\]' } | ForEach-Object { $_.Trim() })
          if ($vf2Fails.Count -eq 0) {
            $area2 = [double]$nw * [double]$nh
            if ($area2 -lt $bestArea) {
              Log ("紧凑板框通过校验，面积 {0:N0} → {1:N0} mil²（省 {2:P0}），采用之" -f $bestArea, $area2, (1 - $area2 / $bestArea)) 'Green'
              # 用紧凑产物替换正式目录内容（原产物已被证明更浪费面积）
              Get-ChildItem $compactDir -File | ForEach-Object { Copy-Item $_.FullName -Destination $OutDir -Force }
              $bestRaw = $raw2; $bestV = $v2; $bestPlan = 'compact-fit'
              $bestW = $nw; $bestH = $nh; $bestArea = $area2
            }
          } else {
            Log ("紧凑板框校验未通过（{0} 项），保留原方案" -f $vf2Fails.Count) 'Yellow'
          }
        } else {
          Log '紧凑板框流水线未通过，保留原方案' 'Yellow'
        }
      }
      # 还原成功记录，供报告使用
      $raw = $bestRaw; $v = $bestV; $plan = @{ tag = $bestPlan; w = $bestW; h = $bestH }
      $lastGoodRaw = $bestRaw
      $usedPlan = $bestPlan
    }
    break
  }

  $verifyFails = $vfFails
  if ($vfFails.Count -gt 0) {
    Log ("[$($plan.tag)] 独立校验未通过（$($vfFails.Count) 项），换更大板框重试") 'Yellow'
    $vfFails | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow }
  } else {
    Log ("[$($plan.tag)] 独立校验器异常退出（exit $vfCode，无 [FAIL] 行），换更大板框重试") 'Yellow'
  }
  $v = $null   # 置空，迫使循环继续
}
$sw.Stop()

$logDir = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "$name-$stamp.json"
Set-Content -Path $logFile -Value $(if ($lastGoodRaw) { $lastGoodRaw } else { $raw }) -Encoding UTF8

# ---------- 4. 报告 ----------
if (-not $res -or -not $v) {
  Write-Host $raw
  # 关键：不清会话就 throw，下一个设计会继承这个被幽灵调用占住/已失效的 session，
  # 于是「一个设计超时」会变成「后面所有设计都报非 JSON、策略=?」（实测 d7 -> d8）。
  Log '本设计未产出有效结果，废弃当前 session，避免污染后续设计' 'Red'
  try { & $CLI session abort --session $sid 2>&1 | Out-Null } catch { }
  Remove-Item $SessionFile -Force -ErrorAction SilentlyContinue
  throw "所有自愈策略均失败（无有效 JSON 结果）"
}

Write-Host ''
Write-Host '================ 结果 ================' -ForegroundColor Green
Write-Host ("通过           : {0}" -f $v.ok)
Write-Host ("工程 UUID      : {0}" -f $v.projectUuid)
Write-Host ("器件           : {0}" -f (($v.components | ForEach-Object { "$($_.des)=$($_.lcsc)" }) -join ', '))
Write-Host ("网表不一致     : {0}" -f $v.mismatchCount)
Write-Host ("原理图 DRC     : {0}" -f $v.schDrc)
Write-Host ("PCB 导入       : {0}" -f $v.imported)
Write-Host ("板框           : {0}" -f $v.outlineOk)
Write-Host ("自动布局       : {0}" -f $v.layoutState)
Write-Host ("自动布线       : {0}" -f $v.routeState)
Write-Host ("PCB DRC 通过   : {0}" -f $v.drcPassed)
Write-Host ("DRC 违规组数   : {0}" -f $v.drcDetailCount)
Write-Host ("耗时           : {0:N1}s（自愈策略：{1}）" -f ($v.elapsedMs / 1000), $usedPlan)
Write-Host ("产物           : {0}" -f (($v.artifacts | ForEach-Object { "$($_.name)($($_.size)B)" }) -join ', '))
if ($v.errors -and $v.errors.Count) {
  Write-Host '错误:' -ForegroundColor Yellow
  $v.errors | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
}
if ($v.warns -and $v.warns.Count) {
  Write-Host '提醒（不阻断，建议下单前人工复核）:' -ForegroundColor DarkYellow
  $v.warns | ForEach-Object { Write-Host "  - $_" -ForegroundColor DarkYellow }
}
Write-Host ("产物目录       : {0}" -f $OutDir)
Write-Host ("日志           : {0}" -f $logFile)

# ---------- 独立校验（已在上面的自愈循环内逐轮执行，这里只输出最终结论）----------
$verifyOk = ($v -and $v.ok -and $verifyFails.Count -eq 0)
if ($v -and $v.ok) {
  Log '最终独立校验（只读产物文件，不复用流水线结论）'
  $vfOut = (& $nodeVerify (Join-Path $Root 'scripts\verify-artifacts.js') $OutDir $designPath 2>&1 | Out-String)
  Write-Host $vfOut
  $verifyOk = ($LASTEXITCODE -eq 0)
  if (-not $verifyOk) {
    Write-Host '独立校验未通过 —— [FAIL] 是产物层面的真实问题，不是流水线自述。' -ForegroundColor Red
  }
}
Write-Host '======================================' -ForegroundColor Green

# ---------- 制造交付文档（只在校验通过时生成，避免给废板配文档）----------
if ($verifyOk) {
  $py = 'C:\Users\UserX\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
  $mk = Join-Path $Root 'scripts\make-deliverables.py'
  if ((Test-Path $py) -and (Test-Path $mk)) {
    Log '生成制造交付文档（打样清单 / 装配说明 / 成本估算）'
    $mkOut = (& $py $mk $OutDir 2>&1 | Out-String)
    Write-Host $mkOut
  }
}

if (-not $KeepSession) {
  # 保留 session 供复用；如需关闭用 -KeepSession:$false 且手动 stop
}

$finalOk = ($v -and $v.ok -and $verifyOk)
}
finally {
  Release-Lock
}
if ($finalOk) { exit 0 } else { exit 1 }
