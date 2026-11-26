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
  [switch]$SkipAudit,
  # 录制真实画布帧（给视频用）。pipeline3.js 里 REC = A.recordMode，
  # 而此前 run-all 从不传这个字段 —— 所以整晚一次帧都没抓到，视频只能拿占位图。
  # 注意：EDA 的 saveFileToFileSystem 要求目录**事先存在**，否则返回 false 而不报错，
  # 所以这里先建目录并把绝对路径传下去。
  [switch]$Record
)
$ErrorActionPreference = 'Stop'
$CLI = 'E:\APP\lceda-pro\lceda-pro.exe'
$Root = $PSScriptRoot
# 【哨兵文件开录】通宵循环起 run-all 时不传 -Record（它只在启动时读一次，改它要重启循环，
# 而中途重启会留下孤儿 lceda owner + 陈旧锁）。但 **run-all 每个设计都新起一个进程**，
# 所以把开关做成仓库根目录下的哨兵文件即可：下一个设计自动生效，不用重启、不用杀进程。
# 实测：加了 -Record 却没人传，导致 out\frames\ 整夜 0 张新帧（14 个目录全在 01:48 之前）。
if (-not $Record -and (Test-Path (Join-Path $PSScriptRoot '.record-on'))) { $Record = [switch]$true }
$SessionFile = Join-Path $Root '.session'
$LockFile = Join-Path $Root '.pipeline.lock'

# 外部 invoke 的 --timeout 只让 CLI 放弃等待，**不中断** render 里的代码（CLI 原文：
# "the code may still be running in the render, and its result will be discarded"）。
# 所以超时必须与流水线自己的预算对齐，否则超时后留下幽灵调用，
# 紧接着的下一次 invoke 一定不是 JSON —— 实测表现为「整批设计无声失败、策略=?」。
# 实测 d7：外部跑满 1316.6s 两次 REQUEST_TIMEOUT，紧接的 d8 直接 SESSION_NOT_FOUND。
$InvokeTimeoutMs = 590000
$PipelineBudgetMs = $InvokeTimeoutMs - 60000     # 60s 余量给结果回传与落盘

function Log($msg, $color = 'Cyan') { Write-Host "[pcb-auto] $msg" -ForegroundColor $color }

# ---------- 代码完整性闸门 ----------
# 无人值守循环每 3~10 分钟启动一个新设计，而 pipeline3.js 随时可能正在被编辑。
# 实测 d6：一次多步重构的中途（括号暂时不配对）被并发读取，
# 白跑一整次 590s 调用换来 `SYNTAX_ERROR: Unexpected token '}'`，
# 还把 session 拖成需要重建的状态，连带下一次也要重来。
# 所以每次 invoke 之前先做语法自检：不通过就退回**上一次验证过的完好备份**，
# 绝不把半成品文件送进 EDA。
$ScriptFile   = Join-Path $Root 'scripts\pipeline3.js'
$ScriptBackup = Join-Path $Root 'scripts\pipeline3.js.lastgood'
$NodeExe      = 'E:\APP\nodejs24\node.exe'

function Test-PipelineSyntax([string]$path) {
  if (-not (Test-Path $path)) { return $false }
  # 第一关：能不能解析。
  $probe = @'
const fs = require('fs');
const s = fs.readFileSync(process.argv[2], 'utf8');
try { new (require('vm').Script)('(async function(){' + s + '\n})'); process.exit(0); }
catch (e) { console.error(e.message); process.exit(3); }
'@
  $tmp = Join-Path $env:TEMP ('dsh-syn-' + [guid]::NewGuid().ToString('N') + '.cjs')
  try {
    Set-Content -Path $tmp -Value $probe -Encoding UTF8
    & $NodeExe $tmp $path 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { return $false }
  } catch { return $false }
  finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }

  # 第二关：契约引用完整性。
  # 语法合法 ≠ 能跑。实测 d8-led-8ch（20:13，白跑 598s）：
  #   EXECUTION_ERROR: drcLeafCount is not defined
  # 文件正处"返回对象已引用 drcLeafCount、let 声明还没写进去"的中间态 ——
  # 语法上完全合法，第一关一声不吭放行，于是不回退 .lastgood，一次真实运行烧光。
  # 无人值守时这种浪费比真 bug 更贵，所以把"返回契约引用了不存在的变量"也算闸门失败。
  # 【路径必须与调用位置无关】旧写法按固定优先级取"一个"根目录再拼 scripts\staticcheck.js：
  # 真实 run-all.ps1 里 $PSScriptRoot = pcb-auto 是对的，但把本函数抽到测试壳
  # （scripts\_testgate.ps1）里跑时，$PSScriptRoot = pcb-auto\scripts，拼出来是
  # scripts\scripts\staticcheck.js —— 不存在。而我刚把"检查器不在"改成 fail-closed，
  # 于是同一份代码在测试壳里会误判不通过。改成候选探测，谁存在用谁。
  $scCands = New-Object System.Collections.ArrayList
  if ($Root) { [void]$scCands.Add((Join-Path $Root 'scripts\staticcheck.js')) }
  if ($PSScriptRoot) {
    [void]$scCands.Add((Join-Path $PSScriptRoot 'scripts\staticcheck.js'))
    [void]$scCands.Add((Join-Path $PSScriptRoot 'staticcheck.js'))
  }
  [void]$scCands.Add((Join-Path (Get-Location).Path 'scripts\staticcheck.js'))
  $sc = $null
  foreach ($c in $scCands) { if ($c -and (Test-Path $c)) { $sc = $c; break } }
  if (-not $sc) {
    # 【fail-closed】检查器不在 = 契约检查**没做**。旧写法是 `if (Test-Path $sc) {...} return $true`，
    # 于是删掉检查器就能让整套契约闸门消失 —— 与 drcReOk/fabReOk/pipeCode 曾经那四处的形状完全相同。
    # 现在这一关承载"delete/modify 返回值是否被丢弃"的静态检查，缺它等于把所有静默改写缺陷放行。
    Log '  契约检查器缺失（scripts\staticcheck.js），无法核对返回契约 -> 判不通过' 'Red'
    return $false
  }
  $scCode = $null
  try {
    $scOut = (& $NodeExe $sc $path 2>&1 | Out-String)
    $scCode = $LASTEXITCODE
  } catch {
    # 【fail-closed】检查器自己崩了 ≠ 流水线没问题。旧写法 `catch { }` 之后直接落到 return $true，
    # 与上面四处是同一个缺陷形状：把"没测成"编码成"通过"。
    Log ("  契约检查执行失败（不能当作通过）：" + $_.Exception.Message) 'Red'
    return $false
  }
  if ($scCode -eq 0) { return $true }
  if ($scCode -eq 2) {
    # exit 2 = 检查器自身环境问题（解析器不可用等）。仍不阻断，但必须留痕，
    # 否则事后无法区分"查过且干净"与"根本没查"。staticcheck 已在 exit 2 前尽力报出
    # 不依赖解析器的那部分缺陷（见其 report-on-exit-2 处理）。
    Log '  契约检查跳过（检查器环境不可用，exit 2）：本次未核对返回契约' 'DarkYellow'
    return $true
  }
  # 【报文不能靠猜关键词过滤】旧写法只保留匹配 '未声明|语法错误' 的行，而 staticcheck 输出是
  # 一行压缩 JSON、真实报文是"丢弃了 delete/modify 的返回值…"—— 两个关键词都不含，
  # 于是这里必然拼出空串，控制台打成"契约检查未通过："后面什么都没有。
  $scMsg = (($scOut -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 2) -join ' ; ')
  if ($scMsg.Length -gt 700) { $scMsg = $scMsg.Substring(0, 700) + '…' }
  Log ("  契约检查未通过（exit $scCode）：" + $scMsg) 'Yellow'
  return $false
}

# 记录"这一次真正跑的是哪一版 pipeline3.js"。
# 原来回退 .lastgood 只在控制台打一句"改用上一次完好备份"，既不说是哪一版、
# 也不留档：事后拿到一个 `out\<设计>` 目录，根本没法判断它是用哪个 revision 产出的。
# 夜间循环里这尤其致命 —— 同一个设计在两次修改前后各跑一遍，产物不同却无从归因。
# 所以这里算指纹（SHA256 前 12 位 + 字节数 + 修改时间），并落一份到产物目录。
$script:PipelineRevUsed = $null
function Get-FileFingerprint([string]$path) {
  $fi = Get-Item $path
  $h = (Get-FileHash $path -Algorithm SHA256).Hash.Substring(0, 12).ToLower()
  return [pscustomobject]@{
    file  = $fi.Name
    sha   = $h
    bytes = $fi.Length
    mtime = $fi.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')
  }
}

function Get-PipelineScript {
  $rev = $null
  $fallback = $false
  if (Test-PipelineSyntax $ScriptFile) {
    try { Copy-Item $ScriptFile $ScriptBackup -Force } catch { }
    $rev = Get-FileFingerprint $ScriptFile
  } else {
    Log 'pipeline3.js 语法检查未通过（可能正在编辑）-> 改用上一次完好备份' 'Yellow'
    if (-not (Test-PipelineSyntax $ScriptBackup)) {
      throw 'pipeline3.js 与备份都无法通过语法检查，停止以免污染 session'
    }
    $rev = Get-FileFingerprint $ScriptBackup
    $fallback = $true
  }
  $script:PipelineRevUsed = [pscustomobject]@{
    file = $rev.file; sha = $rev.sha; bytes = $rev.bytes; mtime = $rev.mtime; fallback = $fallback
  }
  Log ("pipeline3.js 实际使用：{0} sha={1} {2}B mtime={3}{4}" -f `
      $rev.file, $rev.sha, $rev.bytes, $rev.mtime, $(if ($fallback) { '  ← 已回退到备份！' } else { '' })) `
      $(if ($fallback) { 'Yellow' } else { 'DarkGray' })
  return $(if ($fallback) { $ScriptBackup } else { $ScriptFile })
}

function Write-RevisionStamp([string]$dir) {
  if (-not $dir -or -not (Test-Path $dir)) { return }
  $r = $script:PipelineRevUsed
  if (-not $r) { $r = [pscustomobject]@{ file = '?'; sha = '?'; bytes = 0; mtime = '?'; fallback = $null } }
  $lines = @(
    "pipeline3.js = $($r.file)",
    "sha256_12    = $($r.sha)",
    "bytes        = $($r.bytes)",
    "mtime        = $($r.mtime)",
    "fallback     = $($r.fallback)",
    "recorded_at  = $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))"
  )
  try { Set-Content -Path (Join-Path $dir '_pipeline_rev.txt') -Value $lines -Encoding UTF8 } catch { }
}


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
  # 【判据必须用 --owner】lceda-pro.exe 同时扮演三个角色，靠"有没有 --type=" 区分
  # 不出来，会把正常状态误判成泄漏：
  #   E:\APP\lceda-pro\lceda-pro.exe --owner --userData=...        <- 服务端（唯一）
  #   "E:\APP\lceda-pro\lceda-pro.exe" invoke --session ... --code-file ...  <- CLI 客户端（调用期间才在）
  #   ... --type=renderer/gpu/utility/crashpad                     <- 服务端子进程
  # 实测（2026-11-25 22:44）一次正常运行中恰好有 2 个"无 --type="的进程：1 个 --owner
  # 服务端 + 1 个正在飞的 invoke 客户端。旧判据把它们算成 2 个"主进程"，
  # 于是 Ensure-Session 里"主进程 > 1 就全清"会**在 invoke 在飞时把活会话杀掉**。
  # 服务端只有一个，超过 1 个才是真泄漏。
  $procs | Where-Object { [string]$_.CommandLine -match '--owner' }
}

function Get-LcedaClientProcesses {
  # CLI 客户端是瞬态的（invoke/session/open 期间存在），只用于诊断，绝不据此清理。
  $procs = Get-CimInstance Win32_Process -Filter "Name='lceda-pro.exe'" -ErrorAction SilentlyContinue
  if (-not $procs) { return @() }
  $procs | Where-Object {
    $c = [string]$_.CommandLine
    ($c -notmatch '--type=') -and ($c -notmatch '--owner')
  }
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
  # 【兜底：服务端数 > 1 才是泄漏】上面靠 ParentProcessId 判断在 Windows 上不可靠 ——
  # PID 会被复用，等我们去查时那个号可能已经被别的活进程占用，于是死掉的父进程被
  # 误判成"还活着"，孤儿就留下了。
  # 判据必须是 **--owner 的服务端个数**，不是"无 --type= 的进程个数"：
  # 后者把在飞的 invoke 客户端也算进来，正常运行就有 2 个，一清就把活会话清了。
  # 本项目全流程单个 headless 会话，服务端超过 1 个就全是残留，直接全清，
  # 宁可多花一次 ~15s 的冷启动。
  $mains = Get-LcedaMainProcesses
  if (@($mains).Count -gt 1) {
    Log ("检测到 {0} 个并存 lceda-pro 服务端（应只有 1 个），全部回收后重建会话" -f @($mains).Count) 'DarkYellow'
    foreach ($m in $mains) {
      try { Stop-Process -Id $m.ProcessId -Force -ErrorAction Stop; $killed++ } catch { }
    }
  }
  if ($killed -gt 0) {
    Log ("回收 $killed 个孤儿 lceda-pro 实例") 'DarkYellow'
    Start-Sleep -Seconds 3
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

function Remove-AllLceda {
  # 开新会话前把服务端清到 **0 个**，这是唯一确定性判据。
  # 旧判据「父进程是否已死」在 Windows 上会失效：PID 会被复用。
  # 服务端（`--owner`）的父进程是那个已经退出的 CLI shim，ppid 查询时可能
  # 已被 WmiPrvSE 之类的活进程占用 → 判成"父进程还活着" → 孤儿永久留下。
  # 开新会话前没有任何实例值得保留，所以直接全清，不做花式判活。
  # 注意：杀掉服务端会让全部 lceda-pro 一起退出（客户端与子进程都挂在它下面），
  # 所以只应在"确定没有 invoke 在飞"的时机调用（本函数只在开新会话前用）。
  $killed = 0
  foreach ($m in (Get-LcedaMainProcesses)) {
    try { Stop-Process -Id $m.ProcessId -Force -ErrorAction Stop; $killed++ } catch { }
  }
  foreach ($c in (Get-LcedaClientProcesses)) {
    try { Stop-Process -Id $c.ProcessId -Force -ErrorAction Stop; $killed++ } catch { }
  }
  if ($killed -gt 0) {
    Log ("开新会话前清空 $killed 个残留 lceda-pro 进程（服务端 + 客户端）") 'DarkYellow'
    Start-Sleep -Seconds 3
  }
  return $killed
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

  # 3) 开新的（限次，且每次开前**清空**所有残留实例）
  for ($try = 1; $try -le 3; $try++) {
    Remove-AllLceda | Out-Null
    Log "启动新 headless session（第 $try 次）…"
    $open = (& $CLI open --headless true 2>&1 | Out-String)
    $sid = $null
    try { $sid = ($open | ConvertFrom-Json).value.sessionId } catch { }
    if ($sid -and (Test-SessionAlive $sid)) {
      Set-Content -Path $SessionFile -Value $sid -NoNewline
      # 把主进程数记进日志，否则"清干净了"和"又漏了"在日志里长得一样
      Log "session = $sid（主进程 $(@(Get-LcedaMainProcesses).Count) 个）"
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

# ★ 设计快照：独立校验器（verify-artifacts.js，三处调用）与静态审计都是**在校验那一刻**
#   才去读设计文件的，而建板用的是本进程启动时读进 $designObj 的那一份。
#   两者一旦不一致，校验器就拿"新设计"去对"旧板子"，报出一堆根本不存在的缺陷，
#   自愈循环再为这些幻影失败白烧 3 轮。
#   实测 2026-11-26：d7 在 04:00:44 启动时读的是 10 器件旧设计，04:03 设计文件被换成
#   11 器件（补 SWD 排针），04:10 校验器按 11 器件去对 10 器件的板子 → 报
#   「H1 不在 Netlist 里」+「H1.1~H1.8 器件不存在」+「U1.24/25 未连接」共 11 项，
#   连报 3 轮（校验FAIL=33），烧掉 585 秒；而那块板 DRC 0 违规、导出 6/6 全对。
#   所以把建板用的那份设计原样落到产物目录，审计与全部校验都对这个快照做。
#   快照同时让产物目录自证：这块板是由哪份设计建出来的。
$verifyDesignPath = $designPath
try {
  $snapPath = Join-Path $OutDir '_design.snapshot.json'
  [IO.File]::WriteAllText($snapPath, $designJson, (New-Object Text.UTF8Encoding($false)))
  $verifyDesignPath = $snapPath
} catch {
  Log "设计快照写入失败（退回原设计路径，校验可能与建板不一致）：$($_.Exception.Message)" 'Yellow'
}

# 录制帧目录：EDA 的 saveFileToFileSystem 对不存在的目录**返回 false 而不抛错**，
# 所以必须在这里先建出来，否则录制静默变成 0 张帧（视频又只能拿占位图）。
$FramesDir = $null
if ($Record) {
  $FramesDir = Join-Path $Root ("out\frames\" + [DateTime]::Now.ToString('HHmmss'))
  New-Item -ItemType Directory -Force -Path $FramesDir | Out-Null
  Log ("录制模式：画布帧将落到 " + $FramesDir) 'Magenta'
}

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
  $auditOut = (& $nodeAudit (Join-Path $Root 'scripts\audit-design.js') $verifyDesignPath 2>&1 | Out-String)
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

# 面积预估：见下方实测反例。这里只当**下限**用。
$compCount = @($designObj.components).Count
$connCount = @($designObj.connections).Count
# 面积预估值只作**下限**用，绝不用来放大设计声明的板框。
# 2026-11-25 实测反例：旧系数(120000/件+12000/连接)把 d8(20 件 41 连) 估成 289 万 mil²，
# 于是把声明的 1400x1000 放大到 2126x1786 —— 放大后 2 处违规、244s，
# 而 1400x1000 直接通过（150s、0 违规）；d7(10 件 46 连) 同样 2400x1800 失败、
# 1200x900 与 1130x1130 均通过。这类板子「板越大越差」：器件被摊开、走线细长、
# 吸附与间距都更容易出错（d7 填充率仅 0.119）。系数按实测通过面积重新标定。
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
  # 第 1 步：最小板框。**这一段是主战场**：语料里 27 个"多尝试目录"中有 19 个
  # 在第 2 步就通过（见下面的实测表），而这个"第 2 步"在历史链里一直是扩板。
  @{ w = $baseW;        h = $baseH;        tag = 'smart-fit' },
  # 第 2 步：**扩板 1.25 倍**（2026-11-25 起就是这一步，2026-11-26 04:0x 实测重新确认保留）。
  #
  # 实测（27 个多尝试目录，逐个读 _run-<n>-<策略>.json 的 gates）：
  #   条件 = 已失败第 1 次之后，下一步的通过率
  #     第 2 步 = 扩板          → 19 / 27 = **70%**
  #     第 3 步 = 同尺寸重跑    →  1 / (27-19) = **12.5%**
  #   同尺寸重跑 3 对转变：1 次归零通过、1 次 18→2、1 次 14→150（净 +116，反而更差）
  #   扩板     27 对转变：24 次违规下降、2 持平、1 上升（净 −368）
  # 结论：**扩板在它所在的位置上是有效的**，不能拿同尺寸重跑去替换它。
  #
  # 曾经写在这里的判断已撤回：那份"最小板框 55 次 93% / 已扩容 10 次 60%"的对比
  # 有**选择偏差**——扩板只在 smart-fit 已经失败之后才被尝试，拿到的本来就是更难的子集。
  # 拿它去证明"扩板没用"是错的。同类错误清单见 out\_build-ledger.md。
  #
  # 仍然成立的部分：布线是非确定性的。同一设计、同一板框、同一代码，独立运行结果不同
  # （d12：第 1 轮 smart-fit 失败、第 2 轮 152.3s 通过；d1 两轮皆过；d11 一过一败）。
  # 所以"失败"只等于"这几次骰子不好"，不等于"这块板布不出来"。
  @{ w = $baseW * 1.25; h = $baseH * 1.25; tag = 'expand-1.25x' },
  # 第 3 步：**同尺寸重跑**（2026-11-26 02:1x 加）。
  # 依据：实测 `AI_RP2040_系统_15pqy38-20261126-023722` 在 2250x1625 上
  # 第 2 步 4 处违规、第 3 步同尺寸重跑直接归零通过 —— 换一个骰子确实能救回来。
  # 通过的设计在循环末尾 break，走不到这一级，所以对已通过的设计零成本。
  # 扩展名仍是 expand-1.25x 系（尺寸不变），tag 只用于日志/帧目录/遥测文件名，
  # 没有任何下游按 tag 分支（已 grep 核实）。
  @{ w = $baseW * 1.25; h = $baseH * 1.25; tag = 'expand-1.25x-retry' },
  # 第 4 步：**再摇一次同尺寸**（2026-11-26 04:0x 加，放在末尾而不是插到第 2 步）。
  # 动机来自"近失"目录：有些设计三步跑完只差 **2 处违规**且 routeState=completed ——
  #   AI_传感器___充电___显示_19ptbuz-20261126-033920  1 处（11→9→1）
  #   AI_传感器___充电___显示_19ptbuz-20261126-020706  1 处
  #   USBC_Power_ESD-20261126-020219                  1 处
  # 它们已经烧了 3 次尝试（~570s），再给一次 ~150s 的机会，期望高于整轮作废。
  # 代价只在**三步全失败**的设计上（语料 7/27），其余一律 break，不额外花钱。
  @{ w = $baseW * 1.25; h = $baseH * 1.25; tag = 'expand-1.25x-retry2' }
)

# 面积美学：板框是估出来的，过大会导致器件挤在中间、四周大片空白（看着不专业、多花打样费）。
# 实测：布局**之后**剪板框会毁掉布线（布局按大板框排成细长条，剪完扇出空间不足，
# fixClearance 把走线全删、68 个网络全断）。正确顺序是布局**之前**就用小板框重跑。
# 成功一次后，若填充率 < 0.5，按 sqrt(fillRatio) 比例收缩初始板框再试一次，取更优者。
$aestheticTried = $false
$bestArea = [double]::MaxValue
$bestRaw = $null; $bestV = $null; $bestPlan = $null; $bestW = 0; $bestH = 0
# 闸门判决必须跟着"被选中的那个方案"走。
# $drcReOk/$fabReOk 是循环内**最后一次**评出来的值，而最终 $v 来自 $bestV
# （可能是更早、更小的那个方案）—— 两者不同源时终判会张冠李戴：
# 好板被后来的坏计划拖成不通过，或坏板借好计划的名义通过。所以各存一份 best。
# 初值一律取"不通过"：本项目的铁律是"未知 ≠ 通过"。
# 【三态，初值必须是 $null】原先写的是 $false/$false/$true —— 看着"保守"，实际把
# "从没测过"和"测过且不通过"压成同一个值，于是 L1168-1170 那三个 `if ($null -ne …)`
# 全成了死代码：证据文件里 deliverableDocs: null 有 47/72 份，而另外三个字段 null
# 一次都没出现过。判决不受影响（L1128 用 `-eq $true` / `-eq $false`，null 一律拒绝，
# 仍然"未知≠通过"），但人读证据时再也分不出"这块板没走到那一步"和"走到了但没过"。
$bestDrcReOk = $null; $bestFabReOk = $null; $bestFmtBad = $null

$raw = $null; $res = $null; $v = $null; $usedPlan = $null
$lastGoodRaw = $null
$verifyFails = @()
$nodeVerify = 'E:\APP\nodejs24\node.exe'
if (-not (Test-Path $nodeVerify)) { $nodeVerify = 'node' }

# 两道独立闸门的判决先置 $false —— 「未知」永远不能当成「通过」。
# 它们在循环里靠 `continue` 保证通过才会往下走，但 catch 分支是 fail-open 的
# （环境异常只记 Yellow 并跳过），将来任何人在循环里加一个 break 都会让
# 未复核的结果被判通过。所以这里显式初始化为假，最后再由 $finalOk 采信。
$drcReOk = $false
$fabReOk = $false
foreach ($plan in $healPlans) {
  # 【必须在 if ($Record) 之外算】$planIdx 原先只在 $Record 分支里赋值，而夜间无人值守
  # 不带 -Record，于是它是 $null —— 留存下来的遥测被命名成 `_log--smart-fit.json`（中间空，
  # 没有尝试序号），两次尝试会互相覆盖，留存等于白留。实测 2026-11-25 22:56 的 d12 就是这样。
  # 录制帧目录仍然只在 $Record 时建（每帧渲染太慢），但"第几次尝试"这个事实是循环本身的属性。
  $planIdx = [array]::IndexOf($healPlans, $plan) + 1
  $designObj.boardWidthMil = [int]$plan.w
  $designObj.boardHeightMil = [int]$plan.h
  $payload = @{ design = $designObj; outDir = $OutDir; budgetMs = $PipelineBudgetMs } | ConvertTo-Json -Depth 20 -Compress
  if ($Record) {
    # 只有 -Record 时才打开，否则每帧都要走一次 EDA 渲染 + 落盘，白拖慢所有夜间运行。
    #
    # 【每次尝试必须用独立子目录】pipeline3.js 里 shotN 每次进程启动都从 0 开始，
    # 而每个 healPlan 都是一次独立的 invoke（独立进程）。共用一个目录时后一次尝试
    # 会从 0000 开始覆盖前一次的帧，结果是**两套不同布局的板子被混进同一个目录**：
    # 实测 d7（2026-11-25 22:08）目录里 0007/0008/0009 字节完全相同，而 0004-t14s
    # 与最终帧的器件摆放根本不一致（smart-fit 失败后 expand-1.25x 重排）。
    # 用 `序号-tag` 子目录隔离，取素材时只认**真正通过那一跑**的目录。
    $planFrames = Join-Path $FramesDir ("{0}-{1}" -f $planIdx, $plan.tag)
    New-Item -ItemType Directory -Force -Path $planFrames | Out-Null
    $payload = @{ design = $designObj; outDir = $OutDir; budgetMs = $PipelineBudgetMs
      recordMode = $true; framesDir = $planFrames } | ConvertTo-Json -Depth 20 -Compress
    Log ("  录制帧目录：" + $planFrames) 'DarkGray'
  }
  Set-Content -Path $argsFile -Value $payload -Encoding UTF8

  Log ("尝试 [$($plan.tag)] 板框 {0}x{1} mil" -f $plan.w, $plan.h) 'DarkGray'
  try {
    $raw = (& $CLI invoke --session $sid --ext-uuid eda --code-file (Get-PipelineScript) --args (Get-Content $argsFile -Raw) --timeout $InvokeTimeoutMs 2>&1 | Out-String)
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
      $raw = (& $CLI invoke --session $sid --ext-uuid eda --code-file (Get-PipelineScript) --args (Get-Content $argsFile -Raw) --timeout $InvokeTimeoutMs 2>&1 | Out-String)
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
        $raw = (& $CLI invoke --session $sid --ext-uuid eda --code-file (Get-PipelineScript) --args (Get-Content $argsFile -Raw) --timeout $InvokeTimeoutMs 2>&1 | Out-String)
        $res = $raw | ConvertFrom-Json
      } catch { Log "重建后重试仍失败：$($_.Exception.Message)" 'Yellow'; continue }
    }
    if ($res -and -not $res.ok) { Log ("信封错误：" + ($res.error | ConvertTo-Json -Compress)) 'Yellow'; continue }
  }
  $v = $res.value
  $usedPlan = $plan.tag
  # 【留存本次尝试的遥测】pipeline3 每次都写同一个 _run.json / _log.json，
  # 下一次尝试（下一个 healPlan）会把上一次的覆盖掉。实测 2026-11-25 22:45 那次 d10
  # 首次尝试（smart-fit）的失败详情 —— 5 处 Connection Error、patchNoProgress、
  # 长 0.01mil 的退化线段 —— 在 22:50 通过的那次写盘之后就不存在了；d11 那次 437s
  # 失败同样因此无法事后分析，只能靠猜。判据与结论必须落在同一份可复查的文件里。
  # 用 Copy 而不是 Move：被外部掐断的幽灵调用可能稍后才写出 _log.json，Move 会跟它抢。
  foreach ($telName in @('_run.json', '_log.json')) {
    $telSrc = Join-Path $OutDir $telName
    if (-not (Test-Path $telSrc)) {
      if ($telName -eq '_log.json') {
        Log ("  遥测 [{0}] 缺 _log.json（旧版脚本或中途被掐断）" -f $plan.tag) 'DarkYellow'
      }
      continue
    }
    # Join-Path 的结果必须先括起来再 `.json` 拼接：不括的话 PowerShell 把 `+` 当成
    # Join-Path 的第三个位置参数，路径会拼成 `_log-1-smart-fit\+\.json`（实测过）。
    $telDst = (Join-Path $OutDir ('{0}-{1}-{2}' -f [IO.Path]::GetFileNameWithoutExtension($telName), $planIdx, $plan.tag)) + '.json'
    try { Copy-Item $telSrc $telDst -Force } catch {
      # 不得静默：留不下来就等于没有遥测，"悄悄少一份文件"比报错更难查。
      Log ("  遥测 [{0}] 留存失败：{1}" -f $plan.tag, $_.Exception.Message) 'Yellow'
    }
    if ($telName -eq '_log.json') {
      $telOk = '?'
      try { $telOk = (Get-Content $telSrc -Raw | ConvertFrom-Json).ok } catch { }
      Log ("  遥测 [{0}] ok={1} {2}KB -> {3}" -f $plan.tag, $telOk,
        [math]::Round((Get-Item $telSrc).Length / 1KB, 1), (Split-Path $telDst -Leaf)) 'DarkGray'
    }
  }
  if (-not $v.ok) {
    Log ("[$($plan.tag)] 未通过：DRC 违规组 $($v.drcDetailCount)") 'Yellow'
    # 【失败报告要自带判据】原来只写"DRC 违规组 N"，得再翻 _log.json 才知道是哪类违规。
    # 实测这让我反复做同一次取证（d12 是 SMD Pad to Track，d13 是 Slot Region to Track）。
    # 【必须防陈旧读数】invoke 超时返回时 _log.json 可能还是上一次尝试写的，
    # 直接采信就会把旧类型当成这一轮的证据。用 $v.elapsedMs 当参照，陈旧就明说。
    $logPath = Join-Path $OutDir '_log.json'
    if (Test-Path $logPath) {
      try {
        $ageS = [int]((Get-Date) - (Get-Item $logPath).LastWriteTime).TotalSeconds
        $runS = 0
        if ($null -ne $v -and $null -ne $v.elapsedMs) { $runS = [int]([double]$v.elapsedMs / 1000) }
        $staleTag = ''
        if ($ageS -gt ($runS + 30)) { $staleTag = " 【陈旧：写于 $ageS s 前，本次只跑了 $runS s，可能是上一次尝试留下的】" }
        $lj = Get-Content $logPath -Raw | ConvertFrom-Json
        $dl = @($lj.entries | Where-Object { $_.s -eq 'drcLeaves' }) | Select-Object -Last 1
        if ($null -ne $dl -and $null -ne $dl.v -and $null -ne $dl.v.byType) {
          $desc = (@($dl.v.byType.PSObject.Properties) | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join '; '
          Log ("    违规类型" + $staleTag + ": " + $desc) 'DarkYellow'
        } else {
          Log ("    无违规类型明细（_log.json 里没有 drcLeaves）" + $staleTag) 'DarkYellow'
        }
      } catch { Log ("    读 _log.json 失败：" + $_.Exception.Message) 'DarkYellow' }
    } else { Log "    无 _log.json，无法给出违规类型" 'DarkYellow' }
    continue
  }

  # 流水线自述通过还不够 —— 立刻做独立产物校验。
  # 实测踩坑：板框 200x200 时流水线报 ok/DRC=0，但器件跨度 511x498 溢出板框、底层近乎零铜。
  # 只有产物级校验能发现这类"自述成功、实体失败"，所以让校验结果参与自愈判定。
  Log ("[$($plan.tag)] 流水线自述通过，开始独立校验") 'Green'
  # 产物格式规范化（放在独立校验之前，让校验针对**最终要交出去的文件**）。
  # 实测 EDA 自带导出有两处直接阻碍下单：
  #   TestPoints.csv 其实是 xlsx（文件头 50 4B 03 04），名字骗人，CSV 解析器和打样厂上传都会崩；
  #   PnP.csv 是 UTF-16LE + 制表符 + 坐标带 "mm" 后缀（21.935mm），贴片机解析不了。
  # 这两项不是"设计对不对"的问题，而是"能不能拿去生产"的问题，必须修。
  $fmtBad = $false
  $fxRaw = (& $nodeVerify (Join-Path $Root 'scripts\fix-artifacts.js') $OutDir 2>&1 | Out-String)
  $fxCode = $LASTEXITCODE
  ($fxRaw -split "`n" | Where-Object { $_ -match '\[修正\]' }) | ForEach-Object { Log ("    " + $_.Trim()) 'DarkGray' }
  if ($fxCode -ne 0) {
    $fmtBad = $true
    Log ("[$($plan.tag)] 产物格式有问题（exit $fxCode）") 'Red'
    ($fxRaw -split "`n" | Where-Object { $_ -match '\[问题\]' } | Select-Object -First 8) | ForEach-Object { Log ("    " + $_.Trim()) 'DarkRed' }
  }

  $vfRaw = (& $nodeVerify (Join-Path $Root 'scripts\verify-artifacts.js') $OutDir $verifyDesignPath 2>&1 | Out-String)
  $vfCode = $LASTEXITCODE
  $vfFails = @($vfRaw -split "`n" | Where-Object { $_ -match '\[FAIL\]' } | ForEach-Object { $_.Trim() })
  # fail-open 防线：原实现只数 `[FAIL]` 行。校验器自己崩掉时（exit 2、缺 Netlist.json
  # 之类的环境/解析异常）输出里一行 `[FAIL]` 都没有 → 判"独立校验通过"并 break，
  # 直接废掉后面所有自愈策略。这是"自述成功、实体失败"的唯一防线，不能靠数日志行。
  if ($vfCode -ne 0) {
    Log ("[$($plan.tag)] 独立校验器异常退出（exit $vfCode），按未通过处理并继续自愈") 'Red'
    ($vfRaw -split "`n" | Select-Object -First 10) | ForEach-Object { if ($_.Trim()) { Log "    $_" 'DarkRed' } }
  }
  if ($vfCode -eq 0 -and $vfFails.Count -eq 0 -and -not $fmtBad) {
    # 第二道独立闸门：产物校验只读导出文件，**从不重跑 DRC**，
    # 所以流水线自述的 drcPassed 一直无人复核（审计实测 d12 自报 FAIL 而独立复核 PASS，
    # 自报是双向不可信的）。这里开回工程、重建覆铜、自己数违规。
    # 【fail-closed】此前这里写的是 `$drcReOk = $true`，于是 **exit 2 与 catch 都保持"通过"**。
    # 而 exit 2 恰恰是 verify-drc.js 在「CLI 信封失败 / 无输出 / 解析不了 / no board」
    # 时的退出码 —— 全是本文件 194-198 行自己记录的高发故障（一夜 28 个 lceda-pro
    # 打挂端点，后续设计全部退化成"输出不是 JSON"）。后果：环境一抖，一块**从未被复核**
    # 的板子直接走到 $bestDrcReOk = $true → $finalOk = $true → exit 0。
    # 「没复核」和「复核通过」必须分开：现在只有 exit 0 才置真。
    # 环境异常仍不算设计缺陷（原注释的意图保留）—— 但它也不能变成通过，
    # 所以先重试一次，仍异常就判本轮不过（换下一个方案，而不是放过这块板）。
    $drcReOk = $false
    $drcReNote = ''
    for ($drcTry = 1; $drcTry -le 2; $drcTry++) {
      try {
        $drcReRaw = (& $nodeVerify (Join-Path $Root 'scripts\verify-drc.js') $v.projectUuid $sid 2>&1 | Out-String)
        $drcReCode = $LASTEXITCODE
        if ($drcReCode -eq 0) {
          $drcReOk = $true
          Log ("[$($plan.tag)] 独立 DRC 复核通过") 'Green'
          break
        }
        if ($drcReCode -eq 1) {
          $drcReJson = $null
          try { $drcReJson = $drcReRaw | ConvertFrom-Json } catch { }
          # 【别把"查不成"说成"0 处违规"】exit 1 有两条路：真查出违规，或 passed/total
          # 不自洽（verify-drc.js L211 对 consistent=false 也给 exit 2，但 total 缺失时
          # 这里曾经只剩一个 0/`?`），于是日志会出现「复核失败：0 处违规」这种自相矛盾的
          # 句子，把人往"违规统计坏了"的方向引，而真实原因是这份 DRC 结果不可采信。
          $nBad = if ($drcReJson -and $null -ne $drcReJson.total) { $drcReJson.total } else { $null }
          if ($null -eq $nBad) {
            Log ("[$($plan.tag)] 独立 DRC 复核失败：结果里没有 total（consistent=" + $(if ($drcReJson) { $drcReJson.consistent } else { '解析失败' }) + "，itemsErr=" + $(if ($drcReJson) { $drcReJson.itemsErr } else { '?' }) + "），这份 DRC 不可采信") 'Yellow'
          } elseif ([int]$nBad -eq 0) {
            Log ("[$($plan.tag)] 独立 DRC 复核判不通过，但 total=0（consistent=" + $(if ($drcReJson) { $drcReJson.consistent } else { '?' }) + "）—— 自相矛盾的结论，按不通过处理") 'Yellow'
          } else {
            Log ("[$($plan.tag)] 独立 DRC 复核失败：$nBad 处违规（流水线自述通过 = 假阴性）") 'Yellow'
          }
          if ($drcReJson -and $drcReJson.byType) {
            $drcReJson.byType.PSObject.Properties | ForEach-Object { Log ("    违规类型 $($_.Name) = $($_.Value)") 'DarkYellow' }
          }
          $drcReNote = "违规 $nBad 处"
          break
        }
        # 其它退出码 = 环境/用法问题：不算设计失败，但也**不是通过**
        $drcReNote = "环境异常 exit $drcReCode"
        Log ("[$($plan.tag)] 独立 DRC 复核环境异常（exit $drcReCode，第 $drcTry 次），未判定") 'DarkYellow'
        if ($drcTry -lt 2) { Start-Sleep -Seconds 4 }
      } catch {
        $drcReNote = "异常 " + $_.Exception.Message
        Log ("[$($plan.tag)] 独立 DRC 复核异常（第 $drcTry 次）：$($_.Exception.Message)") 'DarkYellow'
        if ($drcTry -lt 2) { Start-Sleep -Seconds 4 }
      }
    }
    if (-not $drcReOk) { Log ("[$($plan.tag)] 独立 DRC 复核未完成（$drcReNote），本轮判不通过") 'Red'; continue }

    # 第三道独立闸门：**能不能拿去打样**。
    # 前两道闸门只看"设计对不对"（网表一致、DRC 无违规），完全不查导出产物本身。
    # fab-audit 实测 7 个洞：TestPoints 是改名的 xlsx、GBO 空层、PnP 单位混杂、
    # BOM 标称≠物料、跨文件重复钻孔…… 这些每一项都会让打样厂拒单或做错板，
    # 而流水线自述 ok、独立校验也 PASS。
    # 判据语义化（不是数文件名）：铜/阻焊/钢网超框、BOM⇄PnP 位号互等、
    # 空层且有底面器件/真插件孔、值↔MPN、GKO 闭合与尺寸对齐。
    # 【fail-closed】同上：此前 `$fabReOk = $true` 使 exit 2 与 catch 都保持"通过"。
    # 而 fabcheck.js 的 exit 2 是**校验器自己崩了**（:915-919 的 catch → return 2）
    # 或输出目录不存在（:315 抛错）—— 校验器崩掉 == 板子通过，这是最不能接受的等价。
    # exit 2 只做一次重试（目录只是被瞬时占用的话能救回来），仍非 0 就判不过。
    # 注意语义变化：环境异常不再等于通过，只等于"本轮未判定"，会换下一个方案。
    $fabReOk = $false
    $fabReNote = ''
    for ($fabTry = 1; $fabTry -le 2; $fabTry++) {
      try {
        $fabRaw = (& $nodeVerify (Join-Path $Root 'scripts\fabcheck.js') $OutDir 2>&1 | Out-String)
        $fabCode = $LASTEXITCODE
        if ($fabCode -eq 0) { $fabReOk = $true; break }
        if ($fabCode -eq 1) {
          $fabJson = $null
          try { $fabJson = $fabRaw | ConvertFrom-Json } catch { }
          Log ("[$($plan.tag)] 产物不可打样（fabcheck exit 1），按未通过处理") 'Yellow'
          if ($fabJson -and $fabJson.blockers) {
            $fabJson.blockers | Select-Object -First 8 | ForEach-Object { Log ("    阻断 $($_.id): $($_.msg)") 'DarkYellow' }
          }
          $fabReNote = '有阻断项'
          break
        }
        $fabReNote = "校验器异常 exit $fabCode"
        Log ("[$($plan.tag)] fabcheck 未完成（exit $fabCode，第 $fabTry 次）：产物可打样性未判定") 'DarkYellow'
        if ($fabTry -lt 2) { Start-Sleep -Seconds 2 }
      } catch {
        $fabReNote = "异常 " + $_.Exception.Message
        Log ("[$($plan.tag)] fabcheck 异常（第 $fabTry 次）：$($_.Exception.Message)") 'DarkYellow'
        if ($fabTry -lt 2) { Start-Sleep -Seconds 2 }
      }
    }
    if (-not $fabReOk) { Log ("[$($plan.tag)] 可打样检查未通过（$fabReNote），本轮判不通过") 'Red'; continue }

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
      $bestDrcReOk = $drcReOk; $bestFabReOk = $fabReOk; $bestFmtBad = $fmtBad
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
        $raw2 = (& $CLI invoke --session $sid --ext-uuid eda --code-file (Get-PipelineScript) --args (Get-Content $argsFile -Raw) --timeout $InvokeTimeoutMs 2>&1 | Out-String)
      } catch { Log "紧凑板框 invoke 异常：$($_.Exception.Message)" 'Yellow' }
      if ($raw2) {
        $res2 = $null
        try { $res2 = $raw2 | ConvertFrom-Json } catch { }
        if ($res2 -and $res2.ok -and $res2.value.ok) {
          $v2 = $res2.value
          $vf2 = (& $nodeVerify (Join-Path $Root 'scripts\verify-artifacts.js') $compactDir $verifyDesignPath 2>&1 | Out-String)
          $vf2Code = $LASTEXITCODE
          $vf2Fails = @($vf2 -split "`n" | Where-Object { $_ -match '\[FAIL\]' } | ForEach-Object { $_.Trim() })
          # 【必须看退出码】主路径 L631 早已改成 ` -eq 0 -and ...`，兄弟分支漏改：
          # 只看有没有 [FAIL] 行时，校验器自己崩掉（exit 2）一行都不打印 → 判通过。
          # 这跟主路径注释里已认领的那个 fail-open 是同一个洞，只是换了个入口。
          if ($vf2Code -eq 0 -and $vf2Fails.Count -eq 0) {
            # 紧凑方案必须自己也过完整三道闸门。
            # 这里原来只跑 verify-artifacts —— 而它**不重跑 DRC、也不查能不能打样**，
            # 于是紧凑板可能带着违规，却因为面积更小被采用，还用下面那句
            # Copy-Item 覆盖掉正式产物目录：等于用一次"少查两道"的通过，
            # 去替换一次"全查过"的通过。覆盖是单向的，原产物不在别处留存。
            # 【fail-closed】此前这里写 `= True` 再进 try —— 全文件最后一个
            # 「先置真、再进 try」的形状。虽然 780-792 三个分支穷尽覆盖了 0/1/其它/异常，
            # 但它是**碰巧闭合**：没有主路径那样的重试，且任何新增退出码都会重新开洞。
            # 直接改成只在 exit 0 时置真，与主路径 L643 同构。
            $drcRe2Ok = $false
            try {
              $d2Raw = (& $nodeVerify (Join-Path $Root 'scripts\verify-drc.js') $v2.projectUuid $sid 2>&1 | Out-String)
              $d2Code = $LASTEXITCODE
              if ($d2Code -eq 0) {
                $drcRe2Ok = $true
              } elseif ($d2Code -eq 1) {
                $drcRe2Ok = $false
                Log '紧凑板框独立 DRC 复核未通过，保留原方案' 'Yellow'
              } elseif ($d2Code -ne 0) {
                # 环境异常时不采用紧凑方案：它要顶替一块已验证的板子，
                # 宁可留着已验证的那块，也不能拿"没复核成"的去换。
                $drcRe2Ok = $false
                Log ("紧凑板框独立 DRC 复核环境异常（exit $d2Code），保守起见保留原方案") 'DarkYellow'
              }
            } catch {
              $drcRe2Ok = $false
              Log ("紧凑板框独立 DRC 复核异常：$($_.Exception.Message)，保留原方案") 'DarkYellow'
            }
            # 【先规范化，再判可打样，最后才覆盖】此前这里直接拿 $compactDir 的**原始导出**
            # 去跑 fabcheck 并通过 Copy-Item -Force 盖进 $OutDir，于是把已经规范化过的
            # PnP.csv（EDA 原版是 UTF-16LE + 制表符 + "21.935mm"）冲回原始格式；
            # 而 $bestFmtBad 在 L812 是**硬写成 $false 的断言，不是测量**——
            # fix-artifacts.js 全文只在 L612 对 $OutDir 跑过一次，从没跑过 $compactDir。
            # fabcheck 抓不住这个（:660-661 对 TAB/utf16le 只记警告，不产生 blocker）。
            # 所以顺序必须是：规范化 → 判可打样 → 覆盖。任一步没通过就不采用。
            $fmt2Bad = $false
            try {
              $fx2Raw = (& $nodeVerify (Join-Path $Root 'scripts\fix-artifacts.js') $compactDir 2>&1 | Out-String)
              $fx2Code = $LASTEXITCODE
              if ($fx2Code -ne 0) {
                $fmt2Bad = $true
                Log ("紧凑板框产物规范化未通过（exit $fx2Code），保留原方案") 'DarkYellow'
                ($fx2Raw -split "`n") | Select-Object -First 6 | ForEach-Object { Log ("    $($_.TrimEnd())") 'DarkYellow' }
              }
            } catch {
              $fmt2Bad = $true
              Log ("紧凑板框产物规范化异常：$($_.Exception.Message)，保留原方案") 'DarkYellow'
            }
            # 【fail-closed】与正式路径同理：exit 2 是 fabcheck 自己崩了，
            # 而这块紧凑板要**顶替一块已全查过的板子**，比正式路径更不能容错。
            $fabRe2Ok = $false
            if ($drcRe2Ok -and -not $fmt2Bad) {
              for ($f2Try = 1; $f2Try -le 2; $f2Try++) {
                try {
                  $f2Raw = (& $nodeVerify (Join-Path $Root 'scripts\fabcheck.js') $compactDir 2>&1 | Out-String)
                  $f2Code = $LASTEXITCODE
                  if ($f2Code -eq 0) { $fabRe2Ok = $true; break }
                  if ($f2Code -eq 1) {
                    Log '紧凑板框产物不可打样，保留原方案' 'Yellow'
                    break
                  }
                  Log ("紧凑板框 fabcheck 未完成（exit $f2Code，第 $f2Try 次），保守起见保留原方案") 'DarkYellow'
                  if ($f2Try -lt 2) { Start-Sleep -Seconds 2 }
                } catch {
                  Log ("紧凑板框 fabcheck 异常（第 $f2Try 次）：$($_.Exception.Message)，保留原方案") 'DarkYellow'
                  if ($f2Try -lt 2) { Start-Sleep -Seconds 2 }
                }
              }
            }
            $area2 = [double]$nw * [double]$nh
            if ($drcRe2Ok -and $fabRe2Ok -and (-not $fmt2Bad) -and $area2 -lt $bestArea) {
              Log ("紧凑板框通过校验，面积 {0:N0} → {1:N0} mil²（省 {2:P0}），采用之" -f $bestArea, $area2, (1 - $area2 / $bestArea)) 'Green'
              # 用紧凑产物替换正式目录内容（现已规范化、且已过 DRC + 可打样 + 格式三项）
              Get-ChildItem $compactDir -File | ForEach-Object { Copy-Item $_.FullName -Destination $OutDir -Force }
              $bestRaw = $raw2; $bestV = $v2; $bestPlan = 'compact-fit'
              # $bestFmtBad 现在反映的是 $compactDir 上 fix-artifacts.js 的**实测**结果（此处必为 $false）
              $bestDrcReOk = $drcRe2Ok; $bestFabReOk = $fabRe2Ok; $bestFmtBad = $fmt2Bad
              $verifyFails = @()
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
  # 【归因必须说真话】原实现只有两个分支：有 [FAIL] 就报"未通过 N 项"，否则一律报
  # "校验器异常退出（exit $vfCode）"。而循环继续的条件是
  # `$vfCode -eq 0 -and $vfFails.Count -eq 0 -and -not $fmtBad`（L735），
  # 所以"exit 0 + 零 [FAIL] + 产物格式硬伤"会走进 else 分支，被打成
  # "校验器异常退出（exit 0）" —— 一个自相矛盾的结论，把排查方向从产物引到校验器。
  $vfWhy = @()
  if ($vfCode -ne 0) { $vfWhy += "校验器退出码 $vfCode" }
  if ($vfFails.Count -gt 0) { $vfWhy += "独立校验 $($vfFails.Count) 项不过" }
  if ($fmtBad) { $vfWhy += '产物格式硬伤' }
  if ($vfWhy.Count -eq 0) { $vfWhy += "原因未归类（vfCode=$vfCode / FAIL=$($vfFails.Count) / fmtBad=$fmtBad）" }
  if ($vfFails.Count -gt 0) {
    Log ("[$($plan.tag)] 独立校验未通过（$($vfFails.Count) 项），换更大板框重试") 'Yellow'
    $vfFails | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow }
  } else {
    Log ("[$($plan.tag)] 未通过：" + ($vfWhy -join ' / ') + "，换更大板框重试") 'Yellow'
  }
  $v = $null   # 置空，迫使循环继续
}
$sw.Stop()

$logDir = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "$name-$stamp.json"
Set-Content -Path $logFile -Value $(if ($lastGoodRaw) { $lastGoodRaw } else { $raw }) -Encoding UTF8
# 无论成败都把"本次实际使用的 pipeline3.js 版本"落到产物目录：
# 失败的设计同样需要归因（是设计的问题，还是这一版代码的问题）。
Write-RevisionStamp $OutDir

# ---------- 4. 报告 ----------
if (-not $res -or -not $v) {
  Write-Host $raw
  # 关键：不清会话就 throw，下一个设计会继承这个被幽灵调用占住/已失效的 session，
  # 于是「一个设计超时」会变成「后面所有设计都报非 JSON、策略=?」（实测 d7 → d8）。
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
# $v.ok 用显式布尔：不能用真值判断 —— 字符串 "false" 在 PowerShell 里是真值，
# 而 accept.ps1 判同一字段用的是 -eq $true。同一仓库对同一字段两套口径迟早被改歪。
$vOkBool = ($null -ne $v -and $v.ok -is [bool] -and $v.ok -eq $true)
$verifyOk = ($vOkBool -and $verifyFails.Count -eq 0)
if ($vOkBool) {
  Log '最终独立校验（只读产物文件，不复用流水线结论）'
  $vfOut = (& $nodeVerify (Join-Path $Root 'scripts\verify-artifacts.js') $OutDir $verifyDesignPath 2>&1 | Out-String)
  Write-Host $vfOut
  $verifyOk = ($LASTEXITCODE -eq 0)
  if (-not $verifyOk) {
    Write-Host '独立校验未通过 —— [FAIL] 是产物层面的真实问题，不是流水线自述。' -ForegroundColor Red
  }
}
Write-Host '======================================' -ForegroundColor Green

# ---------- 制造交付文档（只在校验通过时生成，避免给废板配文档）----------
# 【旧实现三处静默，症状都是"文档没了，而运行照样判 PASS"】
#   ① `if ((Test-Path $py) -and (Test-Path $mk))` 没有 else：python 或脚本不在时
#      整块被跳过，一句解释都不留 —— "没生成"与"生成了没打印"长得一模一样。
#   ② python 路径写死成某一个用户目录；换机器/换 profile 就静默失效。
#   ③ 不查 $LASTEXITCODE，也不查产物是否真落地，结论更没进 $finalOk。
# 为什么这不只是"少三份文档"：打样清单/装配说明/成本估算是"从一个想法到一块 PCB"
# 的组成部分。它静默缺失就必须有人回来补 —— 那正是本流水线要消灭的人工环节。
# 所以现在：三态记录、失败必须写清原因、并进入终判合取。
$docsOk = $null          # $null = 未尝试（校验没过）；$true = 三份齐全；$false = 尝试了但失败
$docsWhy = '未尝试（产物校验未通过，不给废板配文档）'
$docsNames = @('打样检查清单.md', '装配说明.md', '成本估算.md')
if ($verifyOk -eq $true) {
  $mk = Join-Path $Root 'scripts\make-deliverables.py'
  # 依次探测解释器，取第一个真实存在的；全找不到也要说清"找不到"，不能静默。
  $pyCand = New-Object System.Collections.ArrayList
  [void]$pyCand.Add('C:\Users\UserX\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe')
  [void]$pyCand.Add('F:\ANACONDA\1\python.exe')
  foreach ($cmdName in @('python', 'python3', 'py')) {
    $c = Get-Command $cmdName -ErrorAction SilentlyContinue
    if ($c -and $c.Source) { [void]$pyCand.Add($c.Source) }
  }
  $py = $null
  foreach ($cand in $pyCand) { if (Test-Path -LiteralPath $cand) { $py = $cand; break } }
  if (-not (Test-Path -LiteralPath $mk)) {
    $docsOk = $false
    $docsWhy = "交付文档脚本不存在：$mk"
  } elseif (-not $py) {
    $docsOk = $false
    $docsWhy = '找不到可用的 python 解释器（已探测 DSH 运行时 / Anaconda / PATH）'
  } elseif (-not $OutDir) {
    # 逻辑上不可达（校验通过必然有运行目录），但 Join-Path 传 null 会抛；
    # 抛出会跳过 $finalOk 赋值直接进 finally，把"文档没生成"变成"终判没算出来"。
    $docsOk = $false
    $docsWhy = '运行目录为空，无法写入交付文档'
  } else {
    Log '生成制造交付文档（打样清单 / 装配说明 / 成本估算）'
    $docsExit = $null
    try {
      $mkOut = (& $py $mk $OutDir 2>&1 | Out-String)
      $docsExit = $LASTEXITCODE
      Write-Host $mkOut
    } catch {
      $docsExit = -1
      Write-Host ('交付文档生成抛出异常：' + $_.Exception.Message) -ForegroundColor Red
    }
    # 判据是"文件真的存在且非空"，不是"退出码为 0"：退出码只能证明进程跑完了。
    $missing = @()
    foreach ($dn in $docsNames) {
      $fp = Join-Path $OutDir $dn
      if (-not (Test-Path -LiteralPath $fp)) { $missing += ($dn + '(缺失)') }
      elseif ((Get-Item -LiteralPath $fp).Length -le 0) { $missing += ($dn + '(空文件)') }
    }
    if ($docsExit -ne 0) {
      $docsOk = $false
      $docsWhy = "解释器退出码 $docsExit" + $(if ($missing.Count) { '；缺：' + ($missing -join ',') } else { '' })
    } elseif ($missing.Count) {
      $docsOk = $false
      $docsWhy = '退出码 0 但产物不全：缺 ' + ($missing -join ',')
    } else {
      $docsOk = $true
      $docsWhy = '三份文档齐全；解释器：' + $py
    }
    Log ('交付文档：' + $docsWhy) $(if ($docsOk) { 'Green' } else { 'Red' })
  }
  if ($docsOk -ne $true) { Write-Host ('交付文档未齐全：' + $docsWhy) -ForegroundColor Red }
}

if (-not $KeepSession) {
  # 保留 session 供复用；如需关闭用 -KeepSession:$false 且手动 stop
}

# 终判必须是**所有**独立闸门的合取，不能只看流水线自述 + 产物校验。
# 曾经这里只有 `$v.ok -and $verifyOk`：独立 DRC 复核和可打样检查的结论
# 在结构上靠 `continue` 保证，但没有任何一处把它写进最终判决 —— 等于
# "复核失败了、但判决照样能过"。现在显式合取，且未知一律按不通过。 ★三态：`-not $bestFmtBad` 在 $bestFmtBad 为 $null（一次尝试都没被采纳）时得到 $true，等于把"从没测过"写成"格式干净" —— L1033 落盘时已防过同一个坑，而这里才是真正做判决的那一行。
  # 六道闸门全部显式三态：前五道必须 -eq $true，格式那道必须 -eq $false（真的检查过且干净）。
  # null = 未执行/读数缺失 ⇒ 一律不通过；`$v.ok` 若被读成字符串 "false" 也是真值，而
  # accept.ps1 判同一字段用的是 -eq $true —— 同一仓库对同一字段两套口径迟早被改歪。
  # $vOkBool 是 L960 已定好的同一判据，这里复用而不是再写一遍。
  # ★ 新增 deliverableDocs：交付文档是否齐全。校验没过时它是 $null（未尝试），
  #   于是"没校验过的板"不会因为"没要求文档"而白拿通过。
  $finalOk = ($vOkBool -and ($verifyOk -eq $true) -and ($bestDrcReOk -eq $true) -and ($bestFabReOk -eq $true) -and ($bestFmtBad -eq $false) -and ($docsOk -eq $true))
  if (-not $finalOk) {
    # 【归因必须与判决同源】$finalOk 用的是被采纳那一次尝试的 best*，
    # 下面这几行原来用的是**循环变量**（$drcReOk/$fabReOk/$fmtBad，Loop 结束时的值）。
    # 目前两者不矛盾纯属控制流巧合：赋值后必经 break，而 continue 都在赋值之前。
    # 任何一次把 continue 改成 break、或调整方案顺序，就会立刻变成
    # "结论对、归因错" —— 那比不报原因更坏，因为它会把人引向错误的根因。
    $why = New-Object System.Collections.ArrayList
    if (-not $vOkBool) { [void]$why.Add('流水线自述未通过') }
    if ($verifyOk -ne $true) { [void]$why.Add('产物校验未通过或未执行') }
    if ($bestDrcReOk -ne $true) { [void]$why.Add('独立 DRC 复核未通过或未执行') }
    if ($bestFabReOk -ne $true) { [void]$why.Add('可打样检查未通过或未执行') }
    if ($bestFmtBad -ne $false) { [void]$why.Add('产物格式有硬伤或未检查') }
    if ($docsOk -ne $true) { [void]$why.Add('交付文档未齐全：' + $docsWhy) }
    Log ('终判不通过：' + ($why -join '；')) 'Red'
  }
}
finally {
  Release-Lock
  # ---------- 把「独立闸门」的判定落盘，供事后复查归因 ----------
  # accept.ps1 -VerifyOnly 的困境：_run.json 里的 gates 是**流水线自述**，拿它判通过等于没判。
  # 而真正的独立测量（三道离线闸门 + 退出码）只活在本进程内存里，进程一退出就没了 ——
  # 于是事后只能看到自述，分不清「这张板真的被独立复核过」和「它只是说自己过了」。
  # 所以在这里落盘，并记下它测的是哪一版 pipeline3.js（$script:PipelineRevUsed）。
  # 关键区别：这份文件由**复核者**写，不是由**生产者**写。
  # 放在 finally：失败路径会 throw、根本走不到下面的终判输出，
  # 而那种情况恰恰最容易在 $OutDir 里留下一份旧的 ok:true —— 必须也留下证据。
  try {
    if ($OutDir) {
      $evFile = Join-Path $OutDir '_gates.independent.json'
      # ★ 三态，不是布尔：本文件没有 Set-StrictMode，未赋值的变量是 $null。
      #   写成 `-not [bool]$bestFmtBad` 时，若在第一次尝试之前就失败（$bestFmtBad 仍是 $null），
      #   会得到 $true =「格式干净」—— 又一次把"从没测过"写成"通过"，正是本文件要治的那类缺陷。
      #   所以每个字段显式保留 null，让下游 `-eq $true` 自然拒绝它，人读文件也看得见 null。
      # ⚠ 这些赋值必须写在哈希字面量**外面**。写成 [ordered]@{ a = 1; $x = if(...){} } 时
      #   语法检查会通过，运行到那里才抛「哈希文本中不允许使用空键」；而它又被本段的 try/catch
      #   接住，于是整份证据静默不落地 —— 看起来"没写文件"而不是"写失败"。实测踩过。
      $evSelfOk = $null; $evVerify = $null; $evDrc = $null; $evFab = $null; $evFmt = $null; $evDocs = $null
      if ($null -ne $v) { $evSelfOk = [bool]$v.ok }
      if ($null -ne $verifyOk) { $evVerify = [bool]$verifyOk }
      if ($null -ne $bestDrcReOk) { $evDrc = [bool]$bestDrcReOk }
      if ($null -ne $bestFabReOk) { $evFab = [bool]$bestFabReOk }
      if ($null -ne $bestFmtBad) { $evFmt = (-not [bool]$bestFmtBad) }
      if ($null -ne $docsOk) { $evDocs = [bool]$docsOk }
      # 【哨兵值不能当数据】$bestArea 初值是 [double]::MaxValue；若一次尝试都没被采纳，
      # 原样落盘会写出 1.7976931348623157E+308，读的人会以为那是一块真实面积。
      $evArea = $null
      if ($null -ne $bestArea -and $bestArea -ne [double]::MaxValue) { $evArea = $bestArea }
      $ev = [ordered]@{
        kind          = 'independent-gates'
        writer        = 'run-all.ps1'
        generatedAt   = (Get-Date).ToString('o')
        finalOk       = ($finalOk -eq $true)
        reachedFinal  = ($null -ne $finalOk)
        pipelineRev   = $script:PipelineRevUsed
        boardAreaMil2 = $evArea
        # 【哪一档自愈救回这块板，必须机器可读】这个字段一直只出现在人读日志行
        # （`策略=expand-1.25x`）里，于是每次分析"第几档最有效"都得用正则去啃日志，
        # 而且真的啃错过一次（按 `[PASS]` 匹配，而 overnight 打印的是 `  PASS `，
        # 得到 PASS 0 / FAIL 0）。$usedPlan 为 $null 时写 null 而不是空串：
        # 空串在读的人眼里与"策略叫空名字"无法区分。
        strategy      = $(if ($null -ne $usedPlan -and "$usedPlan") { "$usedPlan" } else { $null })
        gates         = [ordered]@{
          pipelineSelfOk  = $evSelfOk
          verifyArtifacts = $evVerify
          drcIndependent  = $evDrc
          fabcheck        = $evFab
          artifactsFormat = $evFmt
          deliverableDocs = $evDocs
        }
      }
      [IO.File]::WriteAllText($evFile, ($ev | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
      Write-Host ("独立闸门证据   : {0}" -f $evFile)
      # ★ 顺序缺陷：这三份交付文档是在**流水线内**由 make-deliverables.py 生成的，
      #   而 _gates.independent.json 要到这个 finally 里才写出来 —— 于是文档里
      #   「独立校验门」一栏永远是「未验证（未找到 _gates.independent.json）」，
      #   实测 8/8 命中，连 finalOk=true 的板也一样：**把「通过了」写成「没验证」**。
      #   措辞本身是诚实的（那一刻它确实没找到），错的是**生成顺序**。
      #   所以修法不是改文案，而是等证据落地后再渲染一次。
      #   实测：重跑仅 0.44s，只改「门禁行」与「面积交叉校验行」，行尾/编码不变；
      #   失败板显示「0 / 5 项为 true」，通过板显示「6 / 6 项为 true（六项全列）」。
      #   只在 $docsOk 已为 $true 时重跑：若文档步骤本身失败，重跑会凭空补出文档，
      #   而门禁里记的是 deliverableDocs=false，那会制造新的不一致。
      if ($docsOk -eq $true -and $py -and $mk -and (Test-Path -LiteralPath $mk)) {
        try {
          $mkOut2 = (& $py $mk $OutDir 2>&1 | Out-String)
          if ($LASTEXITCODE -eq 0) {
            Write-Host '交付文档已按最终门禁重渲染（门禁行不再显示「未验证」）'
          } else {
            Write-Host ('交付文档重渲染退出码 {0}，保留首轮版本：{1}' -f $LASTEXITCODE, $mkOut2.Trim()) -ForegroundColor DarkYellow
          }
        } catch {
          Write-Host ('交付文档重渲染异常，保留首轮版本：' + $_.Exception.Message) -ForegroundColor DarkYellow
        }
      }
    }
  } catch {
    Write-Host ('独立闸门证据写入失败：' + $_.Exception.Message) -ForegroundColor Red
  }
}
if ($finalOk) { exit 0 } else { exit 1 }

