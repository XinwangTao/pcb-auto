#Requires -Version 7.0
<#
  一键复核交付物。

  为什么要有这个脚本：交付说明里的每个数字都由别的脚本算出来，读者的正确做法
  是**自己重跑一遍**，而不是相信那份页面。但一条条手敲没人会做，所以这里把它们
  串起来，最后给一个总判定。

  它只读 + 只重新生成两个可以随时重建的派生物（普查 JSON、交付说明 HTML）。
  不碰 designs/、不碰 out/ 下的产物目录、不碰流水线代码。
  不抢 lceda 锁，可以在无人值守循环跑着的时候执行。

  用法：
    pwsh -File verify-delivery.ps1
    pwsh -File verify-delivery.ps1 -SkipCensus      # 跳过最慢的一步（约 25 s）
#>
[CmdletBinding()]
param(
    [switch]$SkipCensus
)

$ErrorActionPreference = 'Stop'

# ── 编码：先把自己和子进程的语言对齐成 UTF-8 ─────────────────────────────────
#
# 这个脚本会调 node / python 子进程并把它们的 stdout 当 JSON 解析。PowerShell 解码
# **native 命令输出**用的是 [Console]::OutputEncoding，而它的默认值来自系统代码页：
# 中文 Windows 上是 cp936（GBK），而这个仓库里所有子进程都按 UTF-8 写字。
#
# 于是：有控制台时（终端里手敲）一切正常；一旦 stdout 被重定向（管道 / 文件 /
# 被 Agent 用 spawn 抓走）就有一批判据悄悄降级 —— 不是报错，是
# `ConvertFrom-Json` 拿到一串 GBK 乱码后失败，判据被记成「输出解析失败」，
# 或者干脆整条不出现。
#
# 实测（同一份语料、同一台机器、只改调用方式）：
#   在终端里跑        PASS 20 / INFO 12 / WARN 2
#   被 spawn 抓走     PASS 20 / INFO  9 / WARN 1   ← 少了 3 条 INFO + 1 条 WARN
# 少掉的正是依赖 fabcheck / idea-fabchain 的 JSON 输出那几条。
# 这跟「量具读不到输入就沉默」是同一个病：**输出没坏，坏的是解码**。
#
# 所以显式钉住：读子进程输出用 UTF-8，写自己的输出也用 UTF-8。
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }
try { [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $Root

# 两个解释器都靠解析，不写死：本机 PATH 上的 python 是 Anaconda，
# 而这里的量具一直跑在 DSH 自带的那个 python 上 —— 所以 tool-paths.ps1
# 把 $env:USERPROFILE\.dsh\dsh-runtimes\*\...\python.exe 排在 PATH 之前。
. (Join-Path $PSScriptRoot 'scripts\tool-paths.ps1')
# 解析失败要能活下来。CI 上（ubuntu）没有 python，`Resolve-Python` 返回 $null，
# 下游 `Test-Path $null` 在参数绑定阶段抛错，而 `$ErrorActionPreference = 'Stop'`
# 让它变成未捕获的终止性错误 —— PowerShell 以 **1** 退出，也就是「有判据没过」。
# 一台没装 Python 的机器给出的应是「没能测量」（2），不是「交付不一致」（1）。
$Python = $null
$Node = $null
try { $Python = Resolve-Python } catch { }
try { $Node = Resolve-Node } catch { }
$HasPython = [bool]$Python -and (Test-Path -LiteralPath $Python)
$HasNode = [bool]$Node -and (Test-Path -LiteralPath $Node)

$Results = [System.Collections.Generic.List[object]]::new()

function Add-Result {
    param([string]$Name, [string]$State, [string]$Detail)
    $script:Results.Add([pscustomobject]@{ Name = $Name; State = $State; Detail = $Detail })
    $pad = $Name.PadRight(30)
    Write-Host ("  [{0}] {1}  {2}" -f $State, $pad, $Detail)
}

function Invoke-Step {
    param([string]$Name, [string]$Exe, [string[]]$Arguments, [string]$Expect)
    # 一处守卫覆盖全部调用点：要的解释器不在这台机器上，就是「没测成」。
    # 不在这里拦，每个调用点都会各自再犯一次「把 $null 传下去」的错。
    if (-not $Exe -or -not (Test-Path -LiteralPath $Exe)) {
        Add-Result $Name 'NOSAMPLE' '这台机器上没有需要的解释器，这一步没跑成（不是判据没过）'
        return $null
    }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        $out = & $Exe @Arguments 2>&1
        $code = $LASTEXITCODE
    }
    catch {
        $sw.Stop()
        Add-Result $Name 'ERROR' ("调用失败: " + $_.Exception.Message)
        return $null
    }
    $sw.Stop()
    $text = ($out | Out-String)
    if ($code -eq 0) {
        Add-Result $Name 'PASS' ("exit 0  {0:N1}s" -f $sw.Elapsed.TotalSeconds)
    }
    elseif ($code -eq 2) {
        # 退出码 2 统一表示「环境/输入问题，没能测量」，不是「判据没过」。
        # 以前这里一律算 FAIL：于是在一个还没有产物的克隆里，`verify` 会说
        # 「交付不一致」—— 而真相是「还没有东西可核」。把「没检」算进
        # 「失败」的分子，和把它算进「通过」的分母是同一种病。
        Add-Result $Name 'NOSAMPLE' ("exit 2（没能测量，不是判据没过）  {0:N1}s" -f $sw.Elapsed.TotalSeconds)
    }
    else {
        Add-Result $Name 'FAIL' ("exit $code  {0:N1}s" -f $sw.Elapsed.TotalSeconds)
    }
    return $text
}

Write-Host ''
Write-Host '  ════════════════════════════════════════════════════════════════'
Write-Host '   交付物一键复核'
Write-Host ('   目录 ' + $Root)
Write-Host ('   时间 ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Write-Host '  ════════════════════════════════════════════════════════════════'

# ---------- 0. 环境 ----------
Write-Host ''
Write-Host '  0) 环境'
Add-Result 'python' $(if ($HasPython) { 'PASS' } else { 'NOSAMPLE' }) `
    $(if ($HasPython) { $Python } else { '找不到 python：Python 量具都跑不了 —— 这不是判据没过，是这台机器没法测' })
Add-Result 'node' $(if ($HasNode) { 'PASS' } else { 'NOSAMPLE' }) `
    $(if ($HasNode) { $Node } else { '找不到 node：Node 侧判据都跑不了 —— 同上' })
$ff = Get-Command ffmpeg -ErrorAction SilentlyContinue
if ($ff) {
    Add-Result 'ffmpeg' 'PASS' $ff.Source
}
else {
    Add-Result 'ffmpeg' 'WARN' '不在 PATH：只影响混音与 ffprobe 复核，不影响已有成片'
}

# ---------- 1. 离线 DFM 普查 ----------
Write-Host ''
Write-Host '  1) 离线 DFM 普查（自写 Gerber/Excellon 解析器，不复用流水线代码）'
$censusProbe = Join-Path $Root 'out\_probe\fab-census.py'
# 记下跑之前的 mtime。跑完如果它没变，说明量具**没有写出新结果**，
# 那么下面读到的就是上一次（甚至是从仓库里带出来的）报告。
# 不做这个判断，就会把一份旧数据当成「本次普查口径」打印出来 ——
# 全新克隆里那是一条「56 个目录 / 53 可打样」，描述的是作者的机器。
# （`core/ops.mjs` 的 census 早就这么判了，这里是同一个病的第四处。）
$censusJson = Join-Path $Root 'out\_probe\fab-census.json'
$censusBefore = if (Test-Path $censusJson) { (Get-Item $censusJson).LastWriteTimeUtc } else { $null }
if ($SkipCensus) {
    Add-Result 'fab-census' 'SKIP' '按 -SkipCensus 跳过，沿用上一次的 JSON'
}
elseif (Test-Path $censusProbe) {
    $null = Invoke-Step 'fab-census' $Python @($censusProbe) ''
}
else {
    Add-Result 'fab-census' 'FAIL' '缺少 out\_probe\fab-census.py'
}

$censusAfter = if (Test-Path $censusJson) { (Get-Item $censusJson).LastWriteTimeUtc } else { $null }
$censusFresh = ($null -ne $censusBefore) -and ($null -ne $censusAfter) -and ($censusAfter -ne $censusBefore)
# 本机的产物目录数。census 的样本单位是「out\<name>\_run.json」。
$localRunDirs = @(Get-ChildItem (Join-Path $Root 'out') -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName '_run.json') }).Count
if ((Test-Path $censusJson) -and (-not $censusFresh) -and (-not $SkipCensus)) {
    # 读到的是磁盘上的旧报告，而且不是作者主动跳过的 —— 它可能描述别人的机器。
    $cj0 = Get-Content $censusJson -Raw | ConvertFrom-Json
    $snapN = $cj0.all.n
    $snapAt = if ($cj0.measured_at) { $cj0.measured_at } else { '未知时刻' }
    if ($localRunDirs -eq 0) {
        Add-Result '普查口径' 'NOSAMPLE' ("本机 out/ 没有产物目录。文件里那份 {0} 个目录的快照（测于 {1}）是随仓库发布的，描述的不是这台机器 —— 没法据此判交付" -f $snapN, $snapAt)
    }
    else {
        Add-Result '普查口径' 'NOSAMPLE' ("量具没有写出新报告，读到的是旧快照里的 {0} 个目录（测于 {1}），不能当本次测量" -f $snapN, $snapAt)
    }
    Write-Host ("           ≈ 本机实际有 {0} 个带 _run.json 的产物目录" -f $localRunDirs)
}
elseif (Test-Path $censusJson) {
    $cj = Get-Content $censusJson -Raw | ConvertFrom-Json
    $inflight = @($cj.in_flight).Count
    $suffix = if ($SkipCensus) { '（按 -SkipCensus 未重跑，沿用已有 JSON）' } else { '' }
    Add-Result '普查口径' 'INFO' ("{0} 个目录：可打样 {1}，有阻断 {2}，解析错 {3}；因在飞跳过 {4} 个（settle {5}s）{6}" -f `
        $cj.all.n, $cj.all.fab_ok, $cj.all.fab_blocked, $cj.all.fab_error, $inflight, $cj.settle_s, $suffix)
    # 阻断项必须是「真出框」一类，不能是解析器自己造的假阻断
    $ids = ($cj.blocker_ids.PSObject.Properties | ForEach-Object { $_.Name }) -join ', '
    Add-Result '阻断类型' 'INFO' $ids
}

# ---------- 1bis. 有 Gerber 却没有 _run.json 的目录 ----------
# 普查的准入条件是「有 _run.json 且已沉淀」。但「能不能下单」与有没有 _run.json 无关，
# 于是早期产物（11-25 那批、还没写 _run.json 的跑法）成了测量盲区。
# 这里把它们单独拉出来跑一遍，不复用普查的结论，也不再被静默排除。
Write-Host ''
Write-Host '  1bis) 被普查漏掉的「有 Gerber 但无 _run.json」目录'
$orphans = @()
foreach ($d in @(Get-ChildItem (Join-Path $Root 'out') -Directory -ErrorAction SilentlyContinue)) {
    if ($d.Name -like '_*') { continue }
    if (Test-Path (Join-Path $d.FullName '_run.json')) { continue }
    if (-not (Test-Path (Join-Path $d.FullName 'Gerber.zip'))) { continue }
    $orphans += $d
}
if ($orphans.Count -eq 0) {
    Add-Result '孤儿产物' 'PASS' '没有「有 Gerber 却没 _run.json」的目录'
} else {
    $lines = @()
    $blocked = 0
    $thinned = @()
    foreach ($d in $orphans) {
        # 必须解析 JSON，不能拿正则去数所有 "id"：
        # 那样会把 warnings/notes/passes 的 id 一起数进去，标签写「阻断」就变成假话（已犯一次）。
        $j = $null
        try {
            $raw = (& $Node (Join-Path $Root 'scripts\fabcheck.js') $d.FullName 2>&1 | Out-String)
            $j = $raw | ConvertFrom-Json
        } catch { $j = $null }
        if ($null -eq $j) {
            $lines += ("{0} → 输出解析失败" -f $d.Name)
            $blocked++
            continue
        }
        $b = @($j.blockers)
        $bid = @($b | ForEach-Object { $_.id } | Sort-Object -Unique)
        if ($b.Count -gt 0) { $blocked++ }
        $verdict = if ($b.Count -eq 0) { '可下单' } else { "不可下单（$($b.Count) 项阻断 / $($bid.Count) 类）" }
        if ($bid -contains 'gerber.copper.thin') {
            $thinned += [pscustomobject]@{ Name = $d.Name; NBk = $b.Count; NCls = $bid.Count }
        }
        $lines += ("{0} → {1}：{2}" -f $d.Name, $verdict, (($bid | Select-Object -First 5) -join ', '))
    }
    Add-Result '孤儿产物' $(if ($blocked -eq 0) { 'PASS' } else { 'INFO' }) `
        ("$($orphans.Count) 个被普查排除的目录，$blocked 个不能下单。 " + ($lines -join ' ｜ '))
    if ($thinned.Count -gt 0) {
        # 这是本判据自己承认的已知假阳性，必须写出来，否则读者会以为这些板真的零铜
        # 全部阻断就只有这一条的，才叫「被阈值误判」；另有别的阻断的，不能这么说
        $only = @($thinned | Where-Object { $_.NBk -eq 1 })
        $also = @($thinned | Where-Object { $_.NBk -gt 1 })
        $w = ''
        if ($only.Count -gt 0) {
            $nm = @($only | ForEach-Object { $_.Name }) -join '、'
            $w = "$nm 的全部阻断就只有 gerber.copper.thin 这一条，"
            $w += "所以它是被阈值误判的：d1 只有 1 个器件 U1，GTL 仍有 9 个焊盘加 18 段 D01 走线，"
            $w += "属正常最小板，只是总图元数 27 < 40。"
        }
        if ($also.Count -gt 0) {
            $nm2 = @($also | ForEach-Object { "$($_.Name)（$($_.NBk) 项 / $($_.NCls) 类）" }) -join '、'
            if ($w) { $w += " 另 " }
            $w += "$nm2 也含这条，但它们本就另有真阻断，别算进这起误判。"
        }
        $w += "阈值本身没改：改了会让整晚的历史数字不可比"
        Add-Result '铜图元阈值的假阳性' 'WARN' $w
    }
}

# ---------- 2. 交叉核查（每个产物目录内的文件自洽） ----------
Write-Host ''
Write-Host '  2) 产物目录内文件交叉核查'
$cons = Join-Path $Root 'out\_probe\artifact-consistency.py'
if (Test-Path $cons) {
    $t = Invoke-Step 'artifact-consistency' $Python @($cons) ''
    if ($t) {
        $line = ($t -split "`n" | Where-Object { $_ -match '合计' } | Select-Object -Last 1)
        if ($line) { Add-Result '交叉核查结论' 'INFO' $line.Trim() }
    }
}
else {
    Add-Result 'artifact-consistency' 'FAIL' '缺少脚本'
}

# ---------- 3. 成片 ----------
Write-Host ''
Write-Host '  3) 成片（ffprobe 实测，不看自述）'
# video\out 是 .gitignore 的中间物，克隆里根本不存在 —— 以前这里直接
# Get-ChildItem 一个不存在的路径，脚本当场抛错退出，连总判定都打印不出来。
$vidRoot = Join-Path $Root 'video\out'
$vids = @()
if (Test-Path $vidRoot) {
    $vids = @(Get-ChildItem $vidRoot -Filter 'v9-*.mp4' -File -ErrorAction SilentlyContinue |
              Where-Object { $_.Name -notlike '*superseded*' } |
              Sort-Object LastWriteTime -Descending)
}
if ($vids.Count -gt 0) {
    $vid = $vids[0]
    $mkb = [math]::Round($vid.Length / 1MB, 2)
    $h12 = (Get-FileHash $vid.FullName -Algorithm SHA256).Hash.Substring(0, 12).ToUpper()
    Add-Result '成片文件' 'INFO' ($vid.Name + '  ' + $mkb + ' MB  sha256_12=' + $h12)
    $vf = Join-Path $Root 'video\out\_probe\verify-film.ps1'
    if (Test-Path $vf) {
        $vo = & pwsh -NoProfile -ExecutionPolicy Bypass -File $vf -Path $vid.FullName 2>&1
        $vc = $LASTEXITCODE
        $vt = ($vo | Out-String)
        if ($vc -eq 0 -and $vt -match 'VERIFY=PASS') {
            Add-Result 'verify-film' 'PASS' 'VERIFY=PASS（帧数/时长/编码/响度/取样帧非全黑）'
        }
        else {
            Add-Result 'verify-film' 'FAIL' ('exit ' + $vc)
        }
    }
    else {
        Add-Result 'verify-film' 'FAIL' '缺少 verify-film.ps1'
    }
}
elseif (Test-Path $vidRoot) {
    Add-Result '成片文件' 'FAIL' 'video\out 下没有 v9-*.mp4'
}
else {
    Add-Result '成片文件' 'NOSAMPLE' '克隆里没有 video\out（成片是 .gitignore 的中间物，要在本机渲染才有）'
}

# ---------- 4. 交付说明页 ----------
Write-Host ''
Write-Host '  4) 交付说明页（检查发布页有没有说假话 —— 不重写它）'
$mk = Join-Path $Root 'out\_probe\make-dossier.py'
$page = Join-Path $Root 'out\交付说明.html'
# 生成到旁路，**不动**已发布的那一页。
# 以前这里是原地重写：复核动作把被复核的证据改写成本机（在别人的克隆里为空）的
# 语料算出来的一页 0/0，紧接着的跨文件对账读到 0/0，于是报「页面与 README 矛盾」——
# 它指控的正是它自己刚干的。**复核与刷新是两件事**，不该共用一个命令。
$fresh = Join-Path $Root 'out\_probe\_dossier-fresh.html'
if (Test-Path $mk) {
    if (Test-Path $fresh) { Remove-Item $fresh -Force -ErrorAction SilentlyContinue }
    $t = Invoke-Step 'make-dossier' $Python @($mk, '--out', $fresh) ''
    $regenOk = (Test-Path $fresh)
    if (-not $regenOk) {
        # 发布页仍然要检：那些判据问的是「这页有没有说假话」，与本机能不能重算无关。
        # 不能判的是「这页够不够新」，那是没检 —— 记 NOSAMPLE，不许算进通过。
        Add-Result '发布页新鲜度' 'NOSAMPLE' '生成器没跑成功，无法判断发布页是否还跟得上当前语料'
    }
    if (Test-Path $page) {
        $html = Get-Content $page -Raw
        $h2 = ([regex]::Matches($html, '<h2>')).Count
        $tbl = ([regex]::Matches($html, '<table>')).Count
        Add-Result '页面结构' 'INFO' ("$h2 节 / $tbl 表 / " + [math]::Round((Get-Item $page).Length / 1KB, 1) + ' KB')
        # 曾经写下但兑现不了的承诺，一条都不许回潮
        $forbidden = @('不引用任何手写值', '24 项断言', '219/224', '完全共现')
        $hits = @($forbidden | Where-Object { $html.Contains($_) })
        if ($hits.Count -eq 0) {
            Add-Result '旧假承诺已清' 'PASS' '4 条历史假承诺均未出现'
        }
        else {
            Add-Result '旧假承诺已清' 'FAIL' ($hits -join ', ')
        }
        # 靶心那句话必须在
        if ($html -match '不同想法' -and $html -match '做出了能下单的板') {
            Add-Result '靶心一节在' 'PASS' '「想法 → 能下单的板」有分节'
        }
        else {
            Add-Result '靶心一节在' 'FAIL' '缺少想法→可下单一节'
        }
        # 一页只讲成功面的交付说明是不可信的。限制一节必须存在，且条数够。
        # 这条判据的意义：以后谁删掉这一节，复核会当场 FAIL，而不是悄悄少一节。
        $limIdx = $html.IndexOf('<h2>已知限制与证据缺口</h2>')
        if ($limIdx -lt 0) {
            Add-Result '限制一节在' 'FAIL' '页面没有「已知限制与证据缺口」一节（只讲成功面）'
        }
        else {
            $tail = $html.Substring($limIdx)
            $olEnd = $tail.IndexOf('</ol>')
            $seg = if ($olEnd -gt 0) { $tail.Substring(0, $olEnd) } else { $tail }
            $nLi = ([regex]::Matches($seg, '<li>')).Count
            Add-Result '限制一节在' $(if ($nLi -ge 5) { 'PASS' } else { 'FAIL' }) `
                "$nLi 条已知限制（要求 ≥5 条，且必须含验收覆盖缺口与「零人工≠系统没变」）"
            if ($html -notmatch '等于没测') {
                Add-Result '限制说得够狠' 'FAIL' '缺少「没有记录 ≠ 没通过 ≠ 通过 = 没测」这一句'
            }
            elseif ($html -notmatch '零人工') {
                Add-Result '限制说得够狠' 'FAIL' '缺少「零人工 ≠ 系统一成不变」这一句'
            }
            else {
                Add-Result '限制说得够狠' 'PASS' '验收覆盖缺口与「零人工≠系统没变」两句都在'
            }
        }
        # 新页 vs 发布页：同一件事的两个时刻。不同**不等于**矛盾 ——
        # 发布页是随仓库发布的快照，语料变了它就该不同，记 WARN 让人知道该刷新。
        # 真正算 FAIL 的是「两个已发布文件之间不一致」，那条判据在 ⑂ 里。
        if ($regenOk -and (Test-Path $fresh)) {
            $fh = [IO.File]::ReadAllText($fresh, [Text.Encoding]::UTF8)
            $fN = [regex]::Match($fh, '不同想法</div><div class="big">(\d+)').Groups[1].Value
            $fO = [regex]::Match($fh, '做出了能下单的板</div><div class="big">(\d+)').Groups[1].Value
            $pN = [regex]::Match($html, '不同想法</div><div class="big">(\d+)').Groups[1].Value
            $pO = [regex]::Match($html, '做出了能下单的板</div><div class="big">(\d+)').Groups[1].Value
            if ((-not $fN) -or (-not $fO) -or (-not $pN) -or (-not $pO)) {
                Add-Result '发布页新鲜度' 'NOSAMPLE' '新页或发布页里找不到那两个数，判据本身失效'
            }
            elseif ($fN -eq $pN -and $fO -eq $pO) {
                Add-Result '发布页新鲜度' 'PASS' ("发布页与当前语料一致：$fN 条想法 → $fO 条可下单")
            }
            else {
                Add-Result '发布页新鲜度' 'WARN' ("发布页是快照（$pN → $pO），当前语料算出来是 $fN → $fO。要刷新就手工跑 make-dossier.py —— 复核不替你做这件事")
            }
        }
    }
}
else {
    Add-Result 'make-dossier' 'FAIL' '缺少脚本'
}

# ---------- 5. 想法链路 ----------
Write-Host ''
Write-Host '  5) 想法 → 设计 → 板 → 能不能下单'
$chain = Join-Path $Root 'out\_probe\idea-fabchain.py'
if (Test-Path $chain) {
    $t = Invoke-Step 'idea-fabchain' $Python @($chain) ''
    if ($t) {
        foreach ($pat in '汇总：', 'fabcheck exit 0', '两者都过') {
            $line = ($t -split "`n" | Where-Object { $_ -match [regex]::Escape($pat) } | Select-Object -First 1)
            if ($line) { Add-Result '链路' 'INFO' $line.Trim() }
        }
    }
}

# ---------- 6. 循环是否还活着 ----------
Write-Host ''
Write-Host '  6) 无人值守循环'
$lock = Join-Path $Root '.pipeline.lock'
if (Test-Path $lock) {
    $lk = Get-Content $lock
    Add-Result '锁' 'INFO' (($lk | Where-Object { $_ -match 'design=' }) -join ' ')
}
# 只数 --owner：必须用 CIM 拿命令行。Get-Process 的对象上没有 CommandLine 属性，
# 早先那版 $_.CommandLine 恒为 $null → 计数恒 0 → 这个判据永远不会失败，是个空断言。
$lc = @()
try { $lc = @(Get-CimInstance Win32_Process -Filter "Name='lceda-pro.exe'" -ErrorAction Stop) } catch { $lc = @() }
if ($lc.Count -eq 0) {
    Add-Result 'lceda 服务进程' 'INFO' '取不到进程列表（CIM 不可用），本项不作判定'
} else {
    $own = @($lc | Where-Object { "$($_.CommandLine)" -match '--owner' })
    Add-Result 'lceda 服务进程' $(if ($own.Count -le 1) { 'PASS' } else { 'WARN' }) `
        ("$($own.Count) 个 --owner / 共 $($lc.Count) 个子进程（只数 --owner，渲染子进程不算泄漏）")
}

# ---------- 7. 文本完整性：控制字符与替换字符 ----------
Write-Host ''
Write-Host '  7) 交付文本的完整性（防止转义写坏，静默变形）'
$TextTargets = @(
    '交付-README.md',
    'out\_build-ledger.md',
    'out\交付说明.html',
    'out\_probe\make-dossier.py',
    'out\_probe\fab-census.py',
    'out\_probe\idea-fabchain.py',
    'out\_probe\artifact-consistency.py',
    'verify-delivery.ps1'
)
$ctlBad = @()
$fffdBad = @()
$scanned = 0
foreach ($rel in $TextTargets) {
    $fp = Join-Path $Root $rel
    if (-not (Test-Path $fp)) { continue }
    $scanned++
    # 用 .NET 读成字符，才能发现 \f 之类被 Python/PowerShell 转义吞掉的不可见字符
    $txt = [IO.File]::ReadAllText($fp, [Text.Encoding]::UTF8)
    foreach ($ch in $txt.ToCharArray()) {
        $o = [int]$ch
        if ($o -lt 32 -and $o -ne 10 -and $o -ne 13 -and $o -ne 9) {
            $ctlBad += ($rel + ' 含控制字符 U+' + $o.ToString('X4'))
            break
        }
    }
    if ($txt.Contains([char]0xFFFD)) { $fffdBad += ($rel + ' 含替换字符 U+FFFD') }
}
if ($ctlBad.Count -eq 0 -and $fffdBad.Count -eq 0) {
    Add-Result '文本完整性' 'PASS' ("$scanned 个交付文本无控制字符、无替换字符")
} else {
    Add-Result '文本完整性' 'FAIL' (($ctlBad + $fffdBad) -join '；')
}

# ---------- 7bis. README 的结构与承诺 ----------
Write-Host ''
Write-Host '  7bis) 交付 README 的结构与承诺（防编辑丢条目、防假话回潮）'
$rd = Join-Path $Root '交付-README.md'
if (-not (Test-Path $rd)) {
    Add-Result 'README' 'FAIL' '缺少 交付-README.md'
} else {
    $rt = [IO.File]::ReadAllText($rd, [Text.Encoding]::UTF8)
    Add-Result 'README' 'INFO' ([math]::Round((Get-Item $rd).Length / 1KB, 1).ToString() + ' KB')

    # ① 小节标题里承诺的条数 == 实际编号条数。
    # 这条判据的来历：我编辑时把「四个互相独立的验收层」的第 3 条整段弄丢了，
    # 标题写「四个」而正文只剩 1、2、4 —— 只有人从头读才会发现。机器能发现。
    $secHeads = @(
        @{ Key = '## 四个互相独立的验收层'; N = 4 },
        @{ Key = '## 已知限制（不藏）';        N = 8 }
    )
    $cntBad = @()
    foreach ($h in $secHeads) {
        $i0 = $rt.IndexOf($h.Key)
        if ($i0 -lt 0) { $cntBad += ('缺小节：' + $h.Key); continue }
        $i1 = $rt.IndexOf("`n## ", $i0 + $h.Key.Length)
        $body = if ($i1 -gt 0) { $rt.Substring($i0, $i1 - $i0) } else { $rt.Substring($i0) }
        $nBul = ([regex]::Matches($body, '(?m)^- \*\*')).Count +
                ([regex]::Matches($body, '(?m)^\d\. \*\*')).Count
        if ($nBul -lt $h.N) { $cntBad += ("$($h.Key) 只数到 $nBul 条，标题承诺 $($h.N)") }
    }
    if ($cntBad.Count -eq 0) {
        Add-Result '小节条数对得上' 'PASS' '「四个验收层」「已知限制」的条数都够'
    } else {
        Add-Result '小节条数对得上' 'FAIL' ($cntBad -join '；')
    }

    # ② 验收层必须连续编号 1,2,3,4（不许缺号）
    $i0 = $rt.IndexOf('## 四个互相独立的验收层')
    if ($i0 -ge 0) {
        $i1 = $rt.IndexOf("`n## ", $i0 + 4)
        $seg = if ($i1 -gt 0) { $rt.Substring($i0, $i1 - $i0) } else { $rt.Substring($i0) }
        $nums = [regex]::Matches($seg, '(?m)^(\d)\. ') | ForEach-Object { $_.Groups[1].Value }
        if (($nums -join ',') -eq '1,2,3,4') {
            Add-Result '验收层编号连续' 'PASS' '1,2,3,4 四条齐全'
        } else {
            Add-Result '验收层编号连续' 'FAIL' ('实际编号 ' + ($nums -join ',') + '（应为 1,2,3,4）')
        }
    }

    # ③ 已经证伪的旧错话，一句都不许回潮
    $gone = @('全部是同一类', '204 个目录里 203', '约 35 s', '按时间倒序',
              '2026-11-25 白天', '所有含 `Gerber.zip` 的目录', '36 个有设计快照的目录')
    $back = @($gone | Where-Object { $rt.Contains($_) })
    Add-Result '旧错话未回潮' $(if ($back.Count -eq 0) { 'PASS' } else { 'FAIL' }) `
        $(if ($back.Count -eq 0) { "$($gone.Count) 条已被证伪的说法均未出现" } else { $back -join ', ' })

    # ⑤ 跨文件对账：README 的头号数字必须和页面上的完全一致。
    # 这条判据的来历：页面当场算出「30 条想法 → 28 条能下单（93.3%）」，
    # 而 README 同一件事写的是「30 → 26（86.7%）」—— 两份交付物给了两个头号数字。
    # 谁都没错，是它们在两个时刻生成的。但读者只会看到矛盾。
    $pg = Join-Path $Root 'out\交付说明.html'
    if (Test-Path $pg) {
        $ph = [IO.File]::ReadAllText($pg, [Text.Encoding]::UTF8)
        $mN = [regex]::Match($ph, '不同想法</div><div class="big">(\d+)')
        $mO = [regex]::Match($ph, '做出了能下单的板</div><div class="big">(\d+)</div><div class="lbl">([\d.]+)%')
        $mR = [regex]::Match($rt, '\*\*(\d+) 条去重后的中文想法\*\* → \*\*(\d+) 条做成了可下单的板（([\d.]+)%）')
        if (-not $mN.Success -or -not $mO.Success) {
            Add-Result '跨文件对账' 'FAIL' '页面里找不到「不同想法 / 做出了能下单的板」这两个数，判据本身失效'
        }
        elseif (-not $mR.Success) {
            Add-Result '跨文件对账' 'FAIL' 'README 里找不到「N 条去重后的中文想法 → M 条做成了可下单的板」，判据本身失效'
        }
        else {
            $p1 = $mN.Groups[1].Value; $p2 = $mO.Groups[1].Value; $p3 = $mO.Groups[2].Value
            $r1 = $mR.Groups[1].Value; $r2 = $mR.Groups[2].Value; $r3 = $mR.Groups[3].Value
            if ($p1 -eq $r1 -and $p2 -eq $r2 -and $p3 -eq $r3) {
                Add-Result '跨文件对账' 'PASS' "页面与 README 一致：$p1 条想法 → $p2 条可下单（$p3%）"
            }
            else {
                Add-Result '跨文件对账' 'FAIL' `
                    "页面说 $p1 → $p2（$p3%），README 说 $r1 → $r2（$r3%）。读者只会看到矛盾，必须改成同一个时刻的数"
            }
        }
    }
    else {
        Add-Result '跨文件对账' 'INFO' '页面还没生成，无法对账'
    }

    # ④ 必须存在的关键事实（少一条就意味着我把修正弄丢了）
    # 注意：别把锚点写成整句散文。这一段现在由 sync-readme-numbers.py 生成，
    # 措辞一改判据就自己失效了（已踩一次：原来锚「8 个…被静默排除」，改成生成后被判 FAIL）。
    # 锚稳定的子串，不锚整句。
    $must = @('`didea ∪ byidea`', '含 `_run-N-*.json` 的目录', 'snapshot 且 `_run.json.ok=true`',
              '同名不同义', '个没有 `_run.json` 的目录', '**201** 个目录里 **200** 个')
    $lost = @($must | Where-Object { -not $rt.Contains($_) })
    Add-Result '关键修正仍在' $(if ($lost.Count -eq 0) { 'PASS' } else { 'FAIL' }) `
        $(if ($lost.Count -eq 0) { "$($must.Count) 条关键事实都在" } else { '缺：' + ($lost -join ', ') })
}

# ---------- 8. 验收记录的覆盖与自洽 ----------
Write-Host ''
Write-Host '  8) 验收记录的覆盖与自洽（「可下单」这句话的证据面）'
$runDirs = @(Get-ChildItem (Join-Path $Root 'out') -Directory -ErrorAction SilentlyContinue |
             Where-Object { $_.Name -notlike '_*' })
$nRun = 0; $nAcc = 0; $nCmp = 0
$accTrue = 0; $nAccField = 0
$diff = @(); $gateMissing = @()
foreach ($d in $runDirs) {
    if (-not (Test-Path (Join-Path $d.FullName '_run.json'))) { continue }
    $nRun++
    $ap = Join-Path $d.FullName '_accept.json'
    if (-not (Test-Path $ap)) { continue }
    $nAcc++
    try { $a = Get-Content $ap -Raw | ConvertFrom-Json } catch { continue }
    if ($null -eq $a.drcIndependent) { continue }
    $nAccField++
    if ($a.drcIndependent -eq $true) { $accTrue++ }
    # 注意：_gates 里这个键在 gates.* 下面，不在顶层。早先我读顶层拿到 null，
    # 又因为 null 就跳过比较 —— 那是 fail-open，等于让这条判据永远不会报警。
    $gp = Join-Path $d.FullName '_gates.independent.json'
    if (-not (Test-Path $gp)) { $gateMissing += $d.Name; continue }
    try { $g = Get-Content $gp -Raw | ConvertFrom-Json } catch { continue }
    if ($null -eq $g.gates -or $null -eq $g.gates.drcIndependent) { $gateMissing += $d.Name; continue }
    $nCmp++
    if (([bool]$a.drcIndependent) -ne ([bool]$g.gates.drcIndependent)) {
        $diff += ($d.Name + '（_accept=' + $a.drcIndependent + ' / _gates=' + $g.gates.drcIndependent + '）')
    }
}
if ($nRun -eq 0) {
    Add-Result '验收记录覆盖' 'INFO' '没扫到运行目录'
} else {
    Add-Result '验收记录覆盖' 'INFO' ("$nRun 个运行目录里 $nAcc 个有 _accept.json（$($nRun - $nAcc) 个没有；没有记录 ≠ 没通过）")
}
if ($nAccField -gt 0) {
    Add-Result 'drcIndependent 字段值' 'INFO' ("$nAccField 份 _accept.json 里值为 true 的 $accTrue 份")
}
if ($nCmp -gt 0) {
    # 这两份记录的键同名但语义不同：_accept 顶层 = 「本次验收自己有没有独立跑 DRC」（verifyOnly ⇒ false），
    # _gates.gates = 「流水线的 DRC 闸是否独立」（true）。所以数值不等是常态，不等于证据冲突。
    # PowerShell 的续行要求运算符在行尾，所以先拼好再传，别用行首 +
    $msg = "$nCmp 对可比较，其中 $($diff.Count) 对数值不同。"
    $msg += "原因不是证据矛盾，而是同名不同义：_accept 顶层指的是「本次验收自己跑没跑 DRC」，"
    $msg += "_gates.gates 指的是「流水线 DRC 闸是否独立」。把两者当同一件事就会误判"
    Add-Result '两记录同名键' 'WARN' $msg
} elseif ($gateMissing.Count -gt 0) {
    Add-Result '两记录同名键' 'INFO' ("$($gateMissing.Count) 个目录缺 _gates.independent.json 或缺少 gates.drcIndependent，无法比较")
}

# ---------- 总判定 ----------
Write-Host ''
Write-Host '  ════════════════════════════════════════════════════════════════'
$fail = @($Results | Where-Object { $_.State -eq 'FAIL' }).Count
$err = @($Results | Where-Object { $_.State -eq 'ERROR' }).Count
$pass = @($Results | Where-Object { $_.State -eq 'PASS' }).Count
$info = @($Results | Where-Object { $_.State -eq 'INFO' }).Count
$warn = @($Results | Where-Object { $_.State -eq 'WARN' }).Count
$nosample = @($Results | Where-Object { $_.State -eq 'NOSAMPLE' }).Count
Write-Host ("   PASS {0}   INFO {1}   WARN {2}   FAIL {3}   ERROR {4}" -f $pass, $info, $warn, $fail, $err)
if ($nosample -gt 0) {
    # 「没检」单列，不混进 PASS，也不混进 FAIL。
    Write-Host ("   NOSAMPLE {0}  （这些判据因为输入为空或缺失而没跑成 —— 它们既不算通过，也不算失败）" -f $nosample)
}
if ($fail -eq 0 -and $err -eq 0 -and $nosample -eq 0) {
    Write-Host '   VERDICT=PASS  交付物一致，可以据此复核与复现'
    $verdict = 'PASS'
}
elseif ($fail -eq 0 -and $err -eq 0) {
    Write-Host '   VERDICT=NOSAMPLE  没有判据失败，但有判据没跑成 —— 这不是「交付一致」，是「没法判定」'
    $verdict = 'NOSAMPLE'
}
else {
    Write-Host '   VERDICT=FAIL  有判据没过，上面的 FAIL/ERROR 行就是原因'
    $verdict = 'FAIL'
}
Write-Host '  ════════════════════════════════════════════════════════════════'
Write-Host ''

Pop-Location
# 0 通过 / 1 判据没过（是判定结果）/ 2 没能测量（环境或输入问题）。
if ($verdict -eq 'FAIL') { exit 1 }
if ($verdict -eq 'NOSAMPLE') { exit 2 }
exit 0
