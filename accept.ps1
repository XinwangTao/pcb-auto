# ============================================================
# accept.ps1 · 「一句想法 → 一块可打样的 PCB」验收契约
#
# 为什么要有这个脚本
# ------------------
# run-all.ps1 内部已经有四道闸门（audit / 产物校验 / 独立 DRC / 可打样）。
# 但那是**流水线自己说的**。今晚出现过一次真实事故：整轮被判失败，而产物
# 目录里的 _run.json 写着 ok:true —— 文件说通过、日志说失败，两者并存。
# 任何只读其中一份的人都会得出相反结论（我本人就被误导过一次）。
# 根因不是两个写者，而是同一个写者里有两份判定表达式：落盘的用弱版
# （只看 errors.length===0），返回的用强版（还要求导出 6 件全 ok、DRC 通过、
# 布线/布局 completed）。已在 pipeline3.js 收敛成一个 computeOK()。
#
# 所以验收必须独立于流水线的自述：
#   1. _run.json 必须是流水线产生的（kind=pipeline，老产物用 projectUuid 等价判据）
#   2. 6 件产物的**文件系统事实**（存在 + 非空 + 魔数对得上）
#   3. 三道离线闸门各自重跑一遍（产物校验 / 可打样 / 设计审计）
#   4. 全部通过才算 exit 0
#
# 用法：
#   .\accept.ps1 -Idea "做一个 SHT30 温湿度传感器，带 LED 指示和排针"
#   .\accept.ps1 -Design designs\d3-sht30-ldo.json
#   .\accept.ps1 -Idea "..." -Record        # 顺带录真实画布帧给视频用
# ============================================================
param(
  [string]$Idea,
  [string]$Design,
  [switch]$Record,
  [string]$OutDir,
  [string]$Tag = 'accept',
  # 只复核一个已有产物目录，不跑流水线。
  # 存在的意义：闸门必须能被"弄坏的东西"证明它会响，否则它跟没有一样。
  [switch]$VerifyOnly,
  # 【真·独立 DRC 复跑】默认关闭，理由见 2.4 段注释：verify-drc.js 会自己拉起
  # lceda-pro 会话，与无人值守循环并发就变成两个 --owner，正是打挂端点的那个故障。
  [switch]$RecheckDrc
)
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$NodeExe = 'E:\APP\nodejs24\node.exe'
if (-not (Test-Path $NodeExe)) { $NodeExe = 'node' }

if (-not $Idea -and -not $Design -and -not $VerifyOnly) { throw '必须给 -Idea 或 -Design（或 -VerifyOnly + -OutDir）' }
if ($VerifyOnly -and -not $OutDir) { throw '-VerifyOnly 必须同时给 -OutDir' }

$stamp = [DateTime]::Now.ToString('yyyyMMdd-HHmmss')
if (-not $OutDir) { $OutDir = Join-Path $Root "out\$Tag-$stamp" }
# 绝对路径是硬要求：pipeline3.js 把 outDir 原样交给 EDA 进程的 saveFileToFileSystem，
# 传相对路径会让 6 个导出全部 ok:false 且**不报错**（静默空目录）。
$OutDir = [IO.Path]::GetFullPath($OutDir, (Get-Location).Path)

Write-Host ''
Write-Host '════════════════════════════════════════════════════' -ForegroundColor Cyan
Write-Host ' 验收：一句想法 → 一块可打样的 PCB（全程零人工）' -ForegroundColor Cyan
Write-Host '════════════════════════════════════════════════════' -ForegroundColor Cyan
if ($Idea) { Write-Host " 需求：$Idea" }
if ($Design) { Write-Host " 设计：$Design" }
Write-Host " 产物：$OutDir"
Write-Host ''

# ---------- 1. 跑流水线（不解释它的输出，只取退回码） ----------
# -1 = 本次没有跑流水线。曾经初值是 0，于是 -VerifyOnly 的判决文件里写着「流水线 exit 0」，
# 「没发生」被写成「成功了」—— 与 _run.json 说 ok:true 而日志说失败同构。
$pipeCode = -1
$pipeSec = 0.0
$pipeLog = '(跳过：-VerifyOnly)'
if (-not $VerifyOnly) {
  $pwshArgs = @('-NoProfile', '-File', (Join-Path $Root 'run-all.ps1'), '-OutDir', $OutDir)
  if ($Idea) { $pwshArgs += @('-Idea', $Idea) }
  if ($Design) { $pwshArgs += @('-Design', $Design) }
  if ($Record) { $pwshArgs += '-Record' }

  $pipeLog = Join-Path $Root "logs\accept-$stamp-pipeline.log"
  $t0 = Get-Date
  & pwsh @pwshArgs 2>&1 | Tee-Object -FilePath $pipeLog | Out-Host
  $pipeCode = $LASTEXITCODE
  $pipeSec = [Math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
  Write-Host ''
  Write-Host " 流水线退出码 $pipeCode，耗时 ${pipeSec}s（日志 $pipeLog）" -ForegroundColor DarkGray
}

# ---------- 2. 逐项独立核查 ----------
$checks = [ordered]@{}

# 2.1 _run.json 必须是流水线自己写的、且 kind 正确
$runFile = Join-Path $OutDir '_run.json'
$runMeta = $null
if (Test-Path $runFile) {
  try { $runMeta = Get-Content $runFile -Raw | ConvertFrom-Json } catch { $runMeta = $null }
}
$checks['_run.json 存在'] = [bool]$runMeta
# `_run.json` 只有一个写者（pipeline3.js），所以 kind 不是为了区分"谁写的"，
# 而是给未来的读盘者一个显式指纹，避免字段长得像就被当成别的东西。
# 老产物没有 kind 字段（20:38 之前跑的），用 projectUuid 当等价判据 ——
# 那是流水线独有的字段，别处不写，所以它同样能证明"这份文件是流水线产生的"。
$hasKind = ($runMeta -and $runMeta.PSObject.Properties['kind'])
if ($hasKind) {
  $checks['_run.json 来自流水线(kind=pipeline)'] = ($runMeta.kind -eq 'pipeline')
} else {
  # 【旧格式一律不予采信】此前这里用 projectUuid 当等价判据放行。
  # 问题是 kind 不只是"谁写的"标记 —— 20:38 之后的 pipeline3.js 才把
  # computeOK() 从 errors.length===0 改成含 DRC 的 12 项合取，而 computeOK()
  # 的**唯一落盘出口**就是 _run.json.ok。于是旧格式文件的 ok:true 不包含 DRC 语义。
  # 实测 17 个旧目录：_run.json 说 ok:true，同一 run 的日志说 drcPassed=false
  # （最干净一例 ESP32C3_Minimal-20261125-183101：DRC 1 组违规、4 次 attempt 全 false、
  #  产物 6/6 全 ok）。用旧目录做 -VerifyOnly 复验会把 DRC 失败的板子判成验收通过，
  # 这正是"不认自述、必须独立复核"要挡的那种情况。宁可判不过，也不给一个假的通过。
  $checks['_run.json 来自流水线(kind=pipeline)'] = $false
  Write-Host '  ! _run.json 缺 kind 字段：该文件早于「DRC 纳入判定」的改动，其 ok 不含 DRC 语义，不予采信' -ForegroundColor Yellow
}
$checks['_run.json 自述 ok=true'] = ($runMeta -and $runMeta.ok -eq $true)

# 【gates 是"自述核对"，不是"独立核对"—— 标签必须说实话】
# gates 是 computeOK() 的逐项输入（新版才写），它与 ok 出自**同一次、同一个闭包**。
# 把它们拆开写进文件的价值是：ok 的语义漂移时，读者能看见是**哪一项**变了
# （缺失字段可发现、被重定义的字段不可发现）。但这仍然是流水线的自述。
#
# 真独立的证据只有 verify-drc.js：它重开工程、重建覆铜、自己数违规 —— 而
# pipeline3 的 drcPassed 在"覆铜未重建完"的异步窗口里会假阴性（实测 4 个失败里 2 个）。
# 所以下面两项分开记：自述核对（默认）+ 独立复跑（-RecheckDrc 才做）。
# 曾经这里把 gates 标成「独立核对·…」，那是在判决文件里写了一句不成立的断言。
$gates = if ($runMeta -and $runMeta.PSObject.Properties['gates']) { $runMeta.gates } else { $null }
if ($gates) {
  $checks['自述核对·DRC 通过(gates.drcPassed)'] = ($gates.drcPassed -eq $true)
  $checks['自述核对·DRC 叶子为 0(gates.drcLeafCount)'] = ($gates.drcLeafCount -eq 0)
  $checks['自述核对·布线/布局 completed'] = (($gates.routeState -eq 'completed') -and ($gates.layoutState -eq 'completed'))
  $checks['自述核对·6 件产物全 ok(gates)'] = (($gates.exportsTotal -eq 6) -and ($gates.exportsOk -eq 6))
} else {
  $checks['自述核对·DRC 通过(gates.drcPassed)'] = $false
  $checks['自述核对·DRC 叶子为 0(gates.drcLeafCount)'] = $false
  $checks['自述核对·布线/布局 completed'] = $false
  $checks['自述核对·6 件产物全 ok(gates)'] = $false
  Write-Host '  ! _run.json 缺 gates 字段：无法核对 DRC 证据，不予采信 ok' -ForegroundColor Yellow
}

# 2.1b 【观察期·只记录不否决】回滚失败留下的悬空铜
# gates.clearanceRevertOk 是三态：$null = 本次没回滚（**不能读成通过**）/ $true = 全部还原
# / $false = 有铜留在中间态（modify 返回 undefined 而不抛，那条线既没还原也没被删）。
# 现在**故意不进 $checks**：下面 $allOk 要求每一项 -is [bool] -and -eq $true，
# 写进 $checks 等于立刻否决，会把眼下还能过的板子判死 —— 与 pourRebuildOk 当初的处理一致
# （先拿基线，再决定闸门怎么写）。观察一批之后二选一：并入 $checks（否决项）
# 或并入 computeOK()（变成 ok 的一部分）。
$observed = [ordered]@{}
if ($null -ne $gates) {
  $revertState = if ($gates.PSObject.Properties['clearanceRevertOk']) { $gates.clearanceRevertOk } else { $null }
  $revertIds = if ($gates.PSObject.Properties['clearanceRevertDangling']) { @($gates.clearanceRevertDangling) } else { @() }
  # 三态照原样落盘：$null 不能被写成"通过"，也不能被写成"失败"
  $observed['回滚结果(clearanceRevertOk)'] = $revertState
  $observed['回滚残留线段数(clearanceRevertDangling)'] = $revertIds.Count
  if ($revertState -eq $false) {
    Write-Host ("  ! 回滚失败留下 {0} 段悬空铜（只记录，不否决）：{1}" -f $revertIds.Count, ($revertIds -join ', ')) -ForegroundColor Yellow
  } elseif ($null -eq $revertState) {
    Write-Host '  · 本次未发生回滚（clearanceRevertOk=null，不等于通过）' -ForegroundColor DarkGray
  }
}

# 2.2 六件产物的文件系统事实：存在 + 非空 + 魔数
# 只看"文件在"不够 —— 空的 zip / 0 字节的 xlsx 都能骗过 Test-Path。
$want = @(
  @{ n = 'Gerber.zip'; min = 2000; magic = '504b0304' },   # zip
  @{ n = 'BOM.xlsx'; min = 2000; magic = '504b0304' },     # xlsx 也是 zip
  @{ n = 'PnP.csv'; min = 100 },
  @{ n = 'Netlist.json'; min = 200 },
  @{ n = 'TestPoints.xlsx'; min = 500; magic = '504b0304' },
  @{ n = 'Board.pdf'; min = 2000; magic = '25504446' }     # %PDF
)
$artOk = 0
foreach ($w in $want) {
  $p = Join-Path $OutDir $w.n
  $exists = Test-Path $p
  $size = if ($exists) { (Get-Item $p).Length } else { 0 }
  $magicOk = $true
  if ($w.magic -and $size -ge 4) {
    $bytes = [IO.File]::ReadAllBytes($p)[0..3]
    $hex = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
    $magicOk = ($hex -eq $w.magic)
  }
  # 坑：TestPoints 曾经被命名成 .csv 而实质是 xlsx（魔数 504b0304）。
  # 现在源头上已改成 .xlsx，这里保留魔数校验以防回退。
  $ok = $exists -and $size -ge $w.min -and $magicOk
  $checks["产物 $($w.n)"] = $ok
  if ($ok) { $artOk++ }
}
$checks["产物 6/6 齐备"] = ($artOk -eq 6)

# 2.3 三道离线闸门各重跑一遍（这是与流水线自述完全独立的证据）
function Invoke-Gate {
  param([string]$Script, [string[]]$ExtraArgs = @())
  $sp = Join-Path $Root "scripts\$Script"
  if (-not (Test-Path $sp)) { return @{ ran = $false; code = -1; out = "缺脚本 $Script" } }
  $argv = @($sp, $OutDir) + $ExtraArgs
  $out = (& $NodeExe @argv 2>&1 | Out-String)
  return @{ ran = $true; code = $LASTEXITCODE; out = $out }
}

$va = Invoke-Gate -Script 'verify-artifacts.js'
# verify-artifacts 需要 designPath 才能核对"设计⇄网表"；没有就只做结构校验（exit 2 = 用法缺参）
$designPath = $null
if ($Design) {
  $designPath = if (Test-Path (Join-Path $Root $Design)) { Join-Path $Root $Design } else { $Design }
} elseif ($Idea) {
  # -Idea 模式下 idea2design 生成的 design 名形如 gen-<slug>.json
  $slug = ($Idea -replace '[^\w\u4e00-\u9fa5]+', '-')
  if ($slug.Length -gt 30) { $slug = $slug.Substring(0, 30) }
  $cand = Join-Path $Root "designs\gen-$slug.json"
  if (Test-Path $cand) { $designPath = $cand }
}
if ($designPath) {
  $va = Invoke-Gate -Script 'verify-artifacts.js' -Label '产物校验' -ExtraArgs @($designPath)
}
# 【标签必须说实话：exit 2 是"没执行"，exit 1 才是"产物不合格"】
# 以前两种都写成「独立闸门·产物校验 = FAIL」，读判决的人无法区分
# "产物坏了" 与 "缺 -Design 参数所以这项根本没跑"。前者是结论，后者是缺口。
$checks['独立闸门·产物校验'] = ($va.ran -and $va.code -eq 0)
$prodGateNotRun = (-not $va.ran) -or ($va.code -eq 2)
if ($prodGateNotRun) {
  $checks['独立闸门·产物校验(已执行)'] = $false
  Write-Host '  ! 产物校验未执行（缺 design 路径或脚本缺失）：这不是"产物不合格"，是"没核对"。' -ForegroundColor Yellow
} else {
  $checks['独立闸门·产物校验(已执行)'] = $true
}
$checks['独立闸门·可打样(fabcheck)'] = $false
$fb = Invoke-Gate -Script 'fabcheck.js' -Label '可打样'
$checks['独立闸门·可打样(fabcheck)'] = ($fb.ran -and $fb.code -eq 0)
if ($designPath -and (Test-Path (Join-Path $Root 'scripts\audit-design.js'))) {
  $ad = Join-Path $Root 'scripts\audit-design.js'
  & $NodeExe $ad $designPath 2>&1 | Out-Null
  $checks['独立闸门·设计电气审计'] = ($LASTEXITCODE -eq 0)
  $checks['独立闸门·设计电气审计(已执行)'] = $true
} else {
  $checks['独立闸门·设计电气审计'] = $false
  $checks['独立闸门·设计电气审计(已执行)'] = $false
  Write-Host '  ! 设计电气审计未执行：没有可用的 design 路径。' -ForegroundColor Yellow
}

# 2.4 真·独立 DRC 复跑（-RecheckDrc，默认关闭）
# 为什么默认关闭：verify-drc.js 在没给 sessionId 时会**自己拉起一个 lceda-pro 会话**。
# 本脚本的一项关键属性是"可以在无人值守循环跑着的时候并发复核"（无锁、无进程），
# 一旦它起了第二个 --owner 服务端，就正好复现那个把端点打挂、让后续所有设计
# 都"输出不是 JSON"的故障。所以真复跑必须显式开关，并由调用方保证此刻没有循环在跑。
# 关闭时**不加**任何通过项，只把"本次未独立复跑"记进判决文件 ——
# "没做"绝不能写成"通过"（这是 P7 同一条教训）。
$drcIndependent = $false
if ($RecheckDrc) {
  $drcGateKey = '独立闸门·DRC 复跑(verify-drc.js)'
  $checks[$drcGateKey] = $false
  $vdp = Join-Path $Root 'scripts\verify-drc.js'
  if (-not $runMeta -or -not $runMeta.projectUuid) {
    Write-Host '  独立 DRC 复跑无法进行：_run.json 缺 projectUuid' -ForegroundColor Red
  } elseif (-not (Test-Path $vdp)) {
    Write-Host '  独立 DRC 复跑无法进行：缺 scripts\verify-drc.js' -ForegroundColor Red
  } else {
    $vdRaw = (& $NodeExe $vdp $runMeta.projectUuid 2>&1 | Out-String)
    $vdCode = $LASTEXITCODE
    if ($vdCode -eq 0) {
      $checks[$drcGateKey] = $true
      $drcIndependent = $true
    } else {
      Write-Host "  独立 DRC 复跑未通过（exit $vdCode）" -ForegroundColor Red
      ($vdRaw -split "`n") | Select-Object -First 8 | ForEach-Object { Write-Host ("    " + $_.TrimEnd()) -ForegroundColor DarkYellow }
    }
  }
} else {
  Write-Host '  · 未独立复跑 DRC（默认）。要真复核请加 -RecheckDrc，且此刻不要有循环在跑。' -ForegroundColor DarkGray
}

# 2.5 【DRC 到底有没有被独立复核过？这是判决的一部分，不是注释】
# 上面 2.4 只把 drcIndependent 记进判决文件，**并没有让它参与 $allOk** ——
# 于是一条可复现的假通过路径存在：
#   run-all 三道独立闸门都不通过 → 各分支 continue → 换更大板框仍不通过 →
#   $v = $null → throw。**但 $OutDir 里留着上一轮 ok:true / gates.drcPassed:true 的产物**。
#   此时 accept.ps1 会看到：_run.json ✓ + gates ✓ + 6 件产物 ✓ + verify-artifacts ✓
#   （网表确实一致）+ fabcheck ✓（它不做 DRC）+ audit ✓ → 打印"验收通过"。
#   唯一能揭示真相的 $pipelineExit 只被记录、从未被判。
# 现在把"独立 DRC 证据"做成与跑法无关的一条硬判据：
#   · 真跑（非 -VerifyOnly）：证据就是 $pipelineExit —— run-all.ps1 内部已含独立 DRC
#     复核（exit 2 与异常都不再算通过，见 run-all.ps1 的 $drcReOk/$fabReOk），
#     所以退出码 0 是一份**测量**，不是自述。
#   · -VerifyOnly：没有流水线可跑，唯一证据只能是 -RecheckDrc；不做就是"未复核"，
#     按铁律"未复核不得写成通过"处理 —— 它会 FAIL，而不是被悄悄放过。
$drcEvidence = $false
# 来源要说清楚：同一个 drcEvidence 名字此前有两个含义 —— "现场复跑过" 与 "生产者退出了 0"。
# 事后拿它回答"这块板 DRC 被独立复核过吗"会得到假阳，所以把来源单独记一个字段。
$drcEvidenceSource = 'none'
# 独立闸门证据由 run-all.ps1 在 finally 里落盘：**复核者写，不是生产者写**，
# 这才是它区别于 _run.json 里 gates 的地方（gates 与 ok 同源，同源就不是证据）。
$evPath = if ($OutDir) { Join-Path $OutDir '_gates.independent.json' } else { $null }
$evObj = $null
$evWhy = '证据文件不存在'
if ($evPath -and (Test-Path $evPath)) {
  try { $evObj = Get-Content $evPath -Raw | ConvertFrom-Json; $evWhy = '' }
  catch { $evObj = $null; $evWhy = '证据文件无法解析：' + $_.Exception.Message }
}
# 【字段必须是真布尔】`'true' -eq $true` 与 `1 -eq $true` 在 PowerShell 里都为真，
# 而本文件收尾的 $checks 已用 -isnot [bool] 加固 —— 同一个判决文件不能有两套标准，
# 否则手写或被污染的证据能把 "finalOk": 1 送进来。注意**不能**用 [bool] 强转：
# [bool]'false' 也是真。
$evFinalOk = ($null -ne $evObj -and $evObj.finalOk -is [bool] -and $evObj.finalOk -eq $true)
$evGates = if ($null -ne $evObj) { $evObj.gates } else { $null }
$evDrcOk = ($null -ne $evGates -and $evGates.drcIndependent -is [bool] -and $evGates.drcIndependent -eq $true)
$evFabOk = ($null -ne $evGates -and $evGates.fabcheck -is [bool] -and $evGates.fabcheck -eq $true)
$evFmtOk = ($null -ne $evGates -and $evGates.artifactsFormat -is [bool] -and $evGates.artifactsFormat -eq $true)
# 三态里只认「确实测过且测过的东西全过」。finalOk 为假 = 那一轮真的没过。
$evOk = ($evFinalOk -and $evDrcOk -and $evFabOk -and $evFmtOk)
# 【证据必须属于这批产物】"文件能解析"远不够：run-all 写完产物到写完证据之间有实测 18s 窗口，
# 硬杀/断电会留下"本轮产物 + 上一轮 finalOk:true 的证据"；而 $OutDir 尚未规整就抛异常的
# 早失败路径干脆不写证据，旧文件原样留存。两种都能让 -VerifyOnly 采信一份不相干的证据。
# 时效只比**交付物**（不是整个目录：_accept.json 是本文件自己写的，全目录枚举会把
# 第二次 -VerifyOnly 判成陈旧 —— 那是自伤）。
$evKindOk = ($null -ne $evObj -and $evObj.kind -eq 'independent-gates')
$evFresh = $false
$evRevOk = $null
if ($null -ne $evObj -and $OutDir -and (Test-Path $OutDir)) {
  $evTime = $null
  if ($evObj.generatedAt) { $evTime = ($evObj.generatedAt -as [datetime]) }
  $deliverables = @('Netlist.json', 'Gerber.zip', 'BOM.xlsx', 'PnP.csv', 'Board.pdf',
                    'TestPoints.csv', 'TestPoints.xlsx')
  $newest = $null
  foreach ($dn in $deliverables) {
    $dp = Join-Path $OutDir $dn
    if (Test-Path $dp) {
      $mt = (Get-Item $dp).LastWriteTime
      if ($null -eq $newest -or $mt -gt $newest) { $newest = $mt }
    }
  }
  $evFresh = ($null -ne $evTime -and $null -ne $newest -and $evTime -ge $newest)
  # 证据与产物是否出自同一版流水线：三份指纹（证据内 pipelineRev / _pipeline_rev.txt / 磁盘文件）
  # 都在，但此前从没有人比较过 —— "记录但不判定"等于没有。
  $revFile = Join-Path $OutDir '_pipeline_rev.txt'
  if (Test-Path $revFile) {
    $revTxt = Get-Content $revFile -Raw
    $rm = [regex]::Match($revTxt, 'sha256_12\s*=\s*([0-9a-f]{12})')
    if ($rm.Success -and $evObj.pipelineRev -and $evObj.pipelineRev.sha) {
      $evRevOk = ($rm.Groups[1].Value -eq [string]$evObj.pipelineRev.sha)
    }
  }
}
# 失败原因要逐项说清：文件在但内容不合格，与"根本没有文件"是两件不同的事，
# 混成一句会让读的人以为闸门坏了，实际是那一轮真的没过。
if ($null -ne $evObj -and -not $evOk) {
  $bits = New-Object System.Collections.ArrayList
  if (-not $evFinalOk) { [void]$bits.Add('该轮终判不通过或 finalOk 不是布尔真') }
  if ($null -eq $evGates) { [void]$bits.Add('缺 gates 段') }
  else {
    # 【三态必须分开说】$evDrcOk 之类是"真布尔且为真"，它为假有两种完全不同的原因：
    #   gates.X === false        → 这一轮**真跑了、真没过**
    #   gates.X 缺失 / 为 $null  → **没人测**
    # 旧实现两种都打印"未执行"，于是"测过但没过"被写成"没测" —— 读的人会去查闸门
    # 为什么没跑，而该查的是板子为什么没过；反过来也会把"没测"洗成"跑过了"（两者都
    # 只出现在失败分支里，但归因方向相反）。
    # 另外旧实现只点了 6 道闸门里的 3 道，pipelineSelfOk / verifyArtifacts /
    # deliverableDocs 一个字都没提 —— 那三道挂了这里给不出任何线索。
    $gateLabel = [ordered]@{
      pipelineSelfOk  = '流水线自检'
      verifyArtifacts = '产物校验'
      drcIndependent  = '独立 DRC 复核'
      fabcheck        = '可打样检查'
      artifactsFormat = '产物格式'
      deliverableDocs = '交付文档'
    }
    foreach ($gk in $gateLabel.Keys) {
      $prop = $evGates.PSObject.Properties[$gk]
      $gv = if ($null -ne $prop) { $prop.Value } else { $null }
      if ($gv -is [bool] -and $gv -eq $true) { continue }
      if ($gv -is [bool] -and $gv -eq $false) {
        [void]$bits.Add("$($gateLabel[$gk])($gk) 测过但未通过")
      } else {
        [void]$bits.Add("$($gateLabel[$gk])($gk) 未执行/无记录")
      }
    }
  }
  $evWhy = '证据文件存在但不足以采信：' + ($bits -join '、')
}
if ($null -ne $evObj -and $evOk -and (-not $evKindOk -or -not $evFresh)) {
  # 内容全绿但不属于这批产物 —— 最危险的一种，必须点名，绝不能默默放行
  $why2 = New-Object System.Collections.ArrayList
  if (-not $evKindOk) { [void]$why2.Add('kind≠independent-gates') }
  if (-not $evFresh) { [void]$why2.Add('生成时间早于交付物（陈旧证据）') }
  $evOk = $false
  $evWhy = '证据内容全绿但不是这批产物的：' + ($why2 -join '、')
}

if ($VerifyOnly) {
  # 【只设一个闸门】两个来源（现场复跑 / run-all 落盘的证据）是**同一件事的两种测法**，
  # 各自进 $checks 就变成"缺一个就红"——我第一版正是这么写的，结果证据齐了照样不通过。
  # 来源分开记在判决文件里（drcIndependent / gatesEvidence），闸门只问"有没有证据且证据说过"。
  $checks['独立复核·DRC 有证据(-RecheckDrc 或 run-all 闸门文件)'] = ($drcIndependent -or $evOk)
  # 【同源】证据里写着 pipelineRev.sha、目录里有 _pipeline_rev.txt、磁盘上有 pipeline3.js ——
  # 三份指纹此前只记不判，"记录但不判定"等于没有。只在两侧都有指纹时才参与判定：
  # 缺 _pipeline_rev.txt 的旧目录判为"未判定"（$null），既不冒充通过也不误杀。
  if ($null -ne $evRevOk) {
    $checks['独立复核·证据与产物同源(流水线版本一致)'] = ($evRevOk -eq $true)
    if (-not $evRevOk) { Write-Host '  ! 证据文件记录的 pipeline3 版本与目录里产物的版本不一致：这份证据不是为这批产物写的。' -ForegroundColor Red }
  }
  $drcEvidence = ($drcIndependent -or $evOk)
  if ($drcIndependent) { $drcEvidenceSource = "recheck" }
  elseif ($evOk) { $drcEvidenceSource = "gates-file" }
  if (-not $drcEvidence) {
    Write-Host ('  ! -VerifyOnly 下没有独立 DRC 证据：' + $evWhy + '。') -ForegroundColor Yellow
    Write-Host '    未复核不得判通过：要么加 -RecheckDrc，要么复核一个由 run-all.ps1 判定过的产物目录。' -ForegroundColor Yellow
  }
} else {
  # 流水线退出码是独立测量：run-all.ps1 只要有一道闸门不通过就 exit 1
  $checks['独立复核·流水线退出码为 0'] = ($pipeCode -eq 0)
  $drcEvidence = ($pipeCode -eq 0)
  # 注意：这里只是"生产者退出了 0"，accept 本轮**没有**运行 verify-drc.js。
  # 判决文件靠 drcEvidenceSource 区分，避免这个字段被当成"已独立复核"。
  if ($pipeCode -eq 0) { $drcEvidenceSource = "exit-code" } else { $drcEvidenceSource = "none" }
  if ($pipeCode -ne 0) {
    Write-Host "  ! 流水线退出码 $pipeCode ≠ 0：产物目录里可能残留上一轮 ok:true 的文件，不得据此判通过。" -ForegroundColor Yellow
  }
  # 退出码已足以判定；但证据文件若与它矛盾，说明有一方错了 —— 那比"不通过"更需要人看。
  if ($null -ne $evObj) {
    $checks['独立复核·证据文件与退出码一致'] = ($evFinalOk -eq ($pipeCode -eq 0))
    if ($evObj.finalOk -ne ($pipeCode -eq 0)) {
      Write-Host ('  ! 矛盾：证据文件 finalOk=' + $evObj.finalOk + '，流水线退出码=' + $pipeCode) -ForegroundColor Red
    }
  }
}


# 【显式布尔】`-contains $false` 抓不到 $null（`$null -eq $false` 为假），
# 于是任何"取字段值"写法的 check 一旦取到 $null 就会静默变成通过。这里要求每一项**就是 $true**。
$badChecks = @($checks.Keys | Where-Object { $checks[$_] -isnot [bool] -or $checks[$_] -ne $true })
$allOk = ($badChecks.Count -eq 0 -and $checks.Count -gt 0)
Write-Host ''
Write-Host '──── 验收明细 ────' -ForegroundColor Cyan
foreach ($k in $checks.Keys) {
  $v = $checks[$k]
  $mark = if ($v) { 'PASS' } else { 'FAIL' }
  $color = if ($v) { 'Green' } else { 'Red' }
  Write-Host ("  [{0}] {1}" -f $mark, $k) -ForegroundColor $color
}

# 失败时把闸门的原始输出摊开，不留"自己去看日志"
if (-not $allOk) {
  Write-Host ''
  Write-Host '──── 失败闸门原始输出 ────' -ForegroundColor Yellow
  foreach ($pair in @(@('产物校验', $va), @('可打样', $fb))) {
    if ($pair[1].ran -and $pair[1].code -ne 0) {
      Write-Host ("  ▼ {0} (exit {1})" -f $pair[0], $pair[1].code) -ForegroundColor Yellow
      ($pair[1].out -split "`n") | Select-Object -First 24 | ForEach-Object { Write-Host "    $($_.TrimEnd())" }
    }
  }
  if ($runMeta -and $runMeta.PSObject.Properties['errors']) { }
}

$verdict = [ordered]@{
  tool = 'accept'; version = 1
  at = (Get-Date).ToString('o')
  idea = $Idea; design = $Design; designPath = $designPath
  outDir = $OutDir; pipelineExit = $pipeCode; pipelineSec = $pipeSec
  checks = $checks; allOk = $allOk
  # 观察期数据：三态原样落盘，**不参与 $allOk**。等积累出"clearanceRevertOk=false
  # 的板子里最终 ok 的比例"再决定是否升级成否决项 —— 这才是闸门该有的引入方式。
  observed = $observed
  # "本次是否真独立复跑过 DRC"必须留痕，否则下游分不清"复核通过"与"没复核"
  drcIndependent = $drcIndependent; verifyOnly = [bool]$VerifyOnly; pipelineRan = (-not $VerifyOnly)
  # 是否存在"没核对"的缺口：与"不合格"分开记，否则下游把缺口当结论
  designCrossCheck = [bool]$designPath; prodGateExecuted = (-not $prodGateNotRun)
  # 独立闸门证据：drcEvidence 是**判决依据**，gatesEvidence 是它的来源是否可信
  drcEvidence = [bool]$drcEvidence; drcEvidenceSource = $drcEvidenceSource
  gatesEvidence = [bool]$evOk; gatesEvidenceWhy = $evWhy
  # 三态记录：$null = 无法判定（没有文件 / 没有 _pipeline_rev.txt），false = 判定为不属于这批产物
  gatesEvidenceKindOk = $evKindOk; gatesEvidenceFresh = $evFresh; gatesEvidenceRevOk = $evRevOk
  gatesEvidenceRev = $(if ($null -ne $evObj) { $evObj.pipelineRev } else { $null })
  runMetaOk = ($runMeta -and $runMeta.ok)
  artifacts = $artOk
}
$verdictFile = Join-Path $OutDir '_accept.json'
try {
  $verdict | ConvertTo-Json -Depth 8 | Set-Content -Path $verdictFile -Encoding UTF8
} catch {
  # 写不出判决就不是一次可验收的运行：以前这里是空 catch，退出码仍按内存里的 $allOk，
  # 于是"判决文件没写出来"这件事只存在于滚动的控制台行里。
  Write-Host ("  判决文件写入失败：{0}" -f $_.Exception.Message) -ForegroundColor Red
  $allOk = $false
}

Write-Host ''
if ($allOk) {
  Write-Host '════════ 验收通过：想法 → 可打样 PCB，零人工干预 ════════' -ForegroundColor Green
  Write-Host " 产物目录：$OutDir"
  Write-Host " 判决文件：$verdictFile"
  exit 0
} else {
  Write-Host '════════ 验收未通过 ════════' -ForegroundColor Red
  $failed = @($checks.Keys | Where-Object { -not $checks[$_] })
  Write-Host (" 未通过 {0} 项：{1}" -f $failed.Count, ($failed -join ' / ')) -ForegroundColor Red
  Write-Host " 产物目录：$OutDir"
  exit 1
}
