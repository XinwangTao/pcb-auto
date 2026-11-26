# d7d8-make-patches.ps1 —— 生成可验证的补丁（不改原文件）
#
# 做法：读原始文件 → 精确字符串替换（每处断言命中次数）→ 写到 scripts\.patchwork\
#      → 用 git diff --no-index 生成 unified diff → node --check / PowerShell 解析器校验语法。
# 原 pipeline3.js / run-all.ps1 一律不改（用户硬约束），补丁只在 .patchwork 里落地。
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Work = Join-Path $PSScriptRoot '.patchwork'
New-Item -ItemType Directory -Force -Path $Work | Out-Null
$Node = 'E:\APP\nodejs24\node.exe'
$Git = (Get-Command git).Source

function Patch([string]$src, [string]$dst, [object[]]$edits) {
  $t = [IO.File]::ReadAllText($src)
  foreach ($e in $edits) {
    # 目标文件是纯 LF，本脚本的 here-string 是 CRLF —— 统一成 LF 再比对
    $e.old = $e.old -replace "`r`n", "`n"
    $e.new = $e.new -replace "`r`n", "`n"
    $n = ([regex]::Matches($t, [regex]::Escape($e.old))).Count
    if ($n -ne $e.n) { throw ("锚点命中 {0} 次，期望 {1} 次：{2}" -f $n, $e.n, $e.old.Substring(0, [Math]::Min(70, $e.old.Length))) }
    $t = $t.Replace($e.old, $e.new)
  }
  # 原文件是纯 LF，写回必须保持 LF，否则整个文件都进 diff
  [IO.File]::WriteAllText($dst, $t, (New-Object Text.UTF8Encoding($false)))
  return $t
}

# ============================ pipeline3.js ============================
$js = Join-Path $Root 'scripts\pipeline3.js'
$jsNew = Join-Path $Work 'pipeline3.patched.js'

$p1_old = @'
const T0 = Date.now();
const phase = n => log('PHASE', { n, ms: Date.now() - T0 });
'@
$p1_new = @'
const T0 = Date.now();
const phase = n => log('PHASE', { n, ms: Date.now() - T0 });

// ---------- 总预算：外部 invoke --timeout 的镜像 ----------
// 外部 CLI 的 --timeout 到期**不会**中断 render 里的代码，CLI 原文是
// "gave up waiting; the code may still be running in the render, and its result will be
//  discarded"。所以必须让流水线自己在外层掐断之前收尾并 return；否则留下幽灵调用，
// 紧接着的下一次 invoke 撞上它 → 非 JSON（REQUEST_TIMEOUT / SESSION_CLOSED）→
// run-all 报「输出不是 JSON」，一个设计超时会把后面所有设计拖成「无声失败、策略=?」。
// run-all.ps1 传 budgetMs（= --timeout - 60s），缺省 530000 与 590000 对齐。
const BUDGET = Number((A && A.budgetMs) || 530000);
const left = () => BUDGET - (Date.now() - T0);
log('budget', { totalMs: BUDGET });
'@

$p2_old = @'
  const SNAP = 1.5;
  const lineIds = await eda.pcb_PrimitiveLine.getAllPrimitiveId();
  for (const id of lineIds) {
    try {
      const l = await eda.pcb_PrimitiveLine.get(id);
      const net = String(l?.getState_Net?.() || '').toUpperCase();
      if (!net) continue;
      const pool = anchors.filter(a => a.net === net);
      if (!pool.length) continue;
      let sx = l.getState_StartX(), sy = l.getState_StartY();
      let ex = l.getState_EndX(), ey = l.getState_EndY();
      let changed = false;
      for (const a of pool) {
        if (Math.hypot(sx - a.x, sy - a.y) < SNAP && (sx !== a.x || sy !== a.y)) { sx = a.x; sy = a.y; changed = true; }
        if (Math.hypot(ex - a.x, ey - a.y) < SNAP && (ex !== a.x || ey !== a.y)) { ex = a.x; ey = a.y; changed = true; }
      }
      if (changed) {
        // modify 是唯一能正确写回画布的接口；toAsync+done 会报"对象参数不正确"
        await eda.pcb_PrimitiveLine.modify(id, {
          startX: sx, startY: sy, endX: ex, endY: ey });
        snapCount++;
      }
    } catch (e) { log('snapErr', String(e && e.message).slice(0, 100)); }
  }
  log('snappedLines', snapCount);
'@
$p2_new = @'
  const SNAP = 1.5;
  // 按网络分桶：原来每条线都 anchors.filter(a => a.net === net) 全表扫描，
  // 复杂度 O(线数 x 锚点数)。实测该阶段 d7(2400x1800) 111.6s、d6 199.0s，
  // 是整条流水线最贵的一段，且与布线质量无关 —— 纯 CPU 浪费.
  const byNet = new Map();
  for (const a of anchors) {
    if (!byNet.has(a.net)) byNet.set(a.net, []);
    byNet.get(a.net).push(a);
  }
  const lineIds = await eda.pcb_PrimitiveLine.getAllPrimitiveId();
  const seen = new Set();           // net|两端坐标 → 已吸附过的线，用于挡完全重合的重复线
  let snapDup = 0, snapBudgetOut = false;
  for (const id of lineIds) {
    // 预算闸门：给 fixClearance / DRC / 导出留 120s。外部 --timeout 先到就会把这段代码
    // 丢在 render 里继续跑（幽灵调用），下一个 invoke 必挂，所以宁可提前收手.
    if (left() < 120000) { snapBudgetOut = true; break; }
    try {
      const l = await eda.pcb_PrimitiveLine.get(id);
      const net = String(l?.getState_Net?.() || '').toUpperCase();
      if (!net) continue;
      const pool = byNet.get(net);
      if (!pool) continue;
      let sx = l.getState_StartX(), sy = l.getState_StartY();
      let ex = l.getState_EndX(), ey = l.getState_EndY();
      let changed = false;
      for (const a of pool) {
        if (Math.hypot(sx - a.x, sy - a.y) < SNAP && (sx !== a.x || sy !== a.y)) { sx = a.x; sy = a.y; changed = true; }
        if (Math.hypot(ex - a.x, ey - a.y) < SNAP && (ex !== a.x || ey !== a.y)) { ex = a.x; ey = a.y; changed = true; }
      }
      if (!changed) continue;
      // 吸附后两端完全重合的两条同网线 = 一块铜压另一块铜，是 Clearance Error 的直接来源
      // （实测 d8 的 "LED_A5 track 与 GND track 间距 0 mil" 即由此而来）。保留第一条.
      const key = net + '|' + [sx, sy, ex, ey].map(v => Math.round(v * 100)).join(',');
      if (seen.has(key)) { snapDup++; continue; }
      seen.add(key);
      // modify 是唯一能正确写回画布的接口；toAsync+done 会报"对象参数不正确"
      await eda.pcb_PrimitiveLine.modify(id, {
        startX: sx, startY: sy, endX: ex, endY: ey });
      snapCount++;
    } catch (e) { log('snapErr', String(e && e.message).slice(0, 100)); }
  }
  log('snappedLines', { snapped: snapCount, dupSkipped: snapDup, budgetOut: snapBudgetOut, leftMs: left() });
'@

$p3_old = @'
phase('fixClearance');
let clearanceFixes = 0;
for (let round = 0; round < 3; round++) {
'@
$p3_new = @'
phase('fixClearance');
let clearanceFixes = 0;
for (let round = 0; round < 3; round++) {
  if (left() < 90000) { log('clearanceBudgetSkip', { round, leftMs: left() }); break; }
'@

$p4_old = @'
} else {
for (let round = 0; round < 3; round++) {
  let details = null;
'@
$p4_new = @'
} else {
for (let round = 0; round < 3; round++) {
  if (left() < 60000) { log('patchBudgetSkip', { round, leftMs: left() }); break; }
  let details = null;
'@

$p5_old = @'
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await eda.pcb_PrimitivePour.rebuildAllCopperRegions(); } catch (e) { }
'@
$p5_new = @'
  for (let attempt = 0; attempt < 4; attempt++) {
    // 复跑一次 DRC 约 3~8s，跑满 4 次会把收尾拖过外部 timeout → 幽灵调用
    if (attempt > 0 && left() < 60000) { log('drcBudgetSkip', { attempt, leftMs: left() }); break; }
    try { await eda.pcb_PrimitivePour.rebuildAllCopperRegions(); } catch (e) { }
'@

$p6_old = @'
const exports = [];
exports.push(await ex('Gerber.zip', () => eda.pcb_ManufactureData.getGerberFile('AI_Board')));
exports.push(await ex('BOM.xlsx', () => eda.pcb_ManufactureData.getBomFile()));
exports.push(await ex('PnP.csv', () => eda.pcb_ManufactureData.getPickAndPlaceFile('AI_Board', 'csv', 'mm')));
exports.push(await ex('Netlist.json', () => eda.pcb_Net.getNetlist()));
exports.push(await ex('TestPoints.csv', () => eda.pcb_ManufactureData.getTestPointFile('AI_Board')));
exports.push(await ex('Board.pdf', () => eda.pcb_ManufactureData.getPdfFile('AI_Board')));
'@
$p6_new = @'
const exports = [];
// 导出实测 20~51s（6 个文件），是收尾最后一段。预算不够时明确记 skipped，
// 让 ok:false 说得清原因，而不是拖过内部预算后被外部 timeout 变成幽灵调用.
const EXPORT_PLAN = [
  ['Gerber.zip', () => eda.pcb_ManufactureData.getGerberFile('AI_Board')],
  ['BOM.xlsx', () => eda.pcb_ManufactureData.getBomFile()],
  ['PnP.csv', () => eda.pcb_ManufactureData.getPickAndPlaceFile('AI_Board', 'csv', 'mm')],
  ['Netlist.json', () => eda.pcb_Net.getNetlist()],
  ['TestPoints.csv', () => eda.pcb_ManufactureData.getTestPointFile('AI_Board')],
  ['Board.pdf', () => eda.pcb_ManufactureData.getPdfFile('AI_Board')],
];
for (const [nm, getter] of EXPORT_PLAN) {
  if (left() < 45000) {
    exports.push({ name: nm, ok: false, skipped: 'budget', leftMs: left() });
    log('exportSkipped', { name: nm, leftMs: left() });
    continue;
  }
  exports.push(await ex(nm, getter));
}
'@

$p7_old = @'
return {
  // 坑：原表达式不含导出/布局状态。实测 6 个导出全部 ok:false（相对 outDir 导致）
'@
$p7_new = @'
log('budgetEnd', { totalMs: BUDGET, leftMs: left(), elapsedMs: Date.now() - T0 });

return {
  budgetMs: BUDGET, budgetLeftMs: left(),
  // 坑：原表达式不含导出/布局状态。实测 6 个导出全部 ok:false（相对 outDir 导致）
'@

$pre = [regex]::Escape(');' )
Patch $js $jsNew @(
  @{ old = $p1_old; new = $p1_new; n = 1 }
  @{ old = $p2_old; new = $p2_new; n = 1 }
  @{ old = $p3_old; new = $p3_new; n = 1 }
  @{ old = $p4_old; new = $p4_new; n = 1 }
  @{ old = $p5_old; new = $p5_new; n = 1 }
  @{ old = $p6_old; new = $p6_new; n = 1 }
  @{ old = $p7_old; new = $p7_new; n = 1 }
) | Out-Null
# pipeline3.js 是「async 函数体」而不是模块：直接 node --check 连原文件都过不了
# （line 119 top-level await）。包成 async IIFE 再检查，才是等价的语法校验。
function Check-Js([string]$path) {
  $w = Join-Path $Work ('.check-' + [IO.Path]::GetFileNameWithoutExtension($path) + '.js')
  [IO.File]::WriteAllText($w, "(async () => {`n" + [IO.File]::ReadAllText($path) + "`n})();`n", (New-Object Text.UTF8Encoding($false)))
  & $Node --check $w 2>&1 | Out-String
  return $LASTEXITCODE
}
$orig = Check-Js $js
if ($orig -ne 0) { throw "原始 pipeline3.js 基线语法检查不通过（包装方式不对）" }
Write-Host "[patch] 基线 pipeline3.js 包装语法 OK" -ForegroundColor DarkGray
if ((Check-Js $jsNew) -ne 0) { throw "pipeline3 补丁语法错误" }
Write-Host "[patch] pipeline3.patched.js 语法 OK" -ForegroundColor Green

# ============================ run-all.ps1 ============================
$ps = Join-Path $Root 'run-all.ps1'
$psNew = Join-Path $Work 'run-all.patched.ps1'

$r1_old = @'
$LockFile = Join-Path $Root '.pipeline.lock'
'@
$r1_new = @'
$LockFile = Join-Path $Root '.pipeline.lock'

# 外部 invoke 的 --timeout 只让 CLI 放弃等待，**不中断** render 里的代码（CLI 原文：
# "the code may still be running in the render, and its result will be discarded"）。
# 所以超时必须与流水线自己的预算对齐，否则超时后留下幽灵调用，
# 紧接着的下一次 invoke 一定不是 JSON —— 实测表现为「整批设计无声失败、策略=?」。
$InvokeTimeoutMs = 590000
$PipelineBudgetMs = $InvokeTimeoutMs - 60000     # 60s 余量给结果回传与落盘
'@

$r2_old = @'
  $payload = @{ design = $designObj; outDir = $OutDir } | ConvertTo-Json -Depth 20 -Compress
'@
$r2_new = @'
  $payload = @{ design = $designObj; outDir = $OutDir; budgetMs = $PipelineBudgetMs } | ConvertTo-Json -Depth 20 -Compress
'@

$r3_old = @'
$healPlans = @(
'@
$r3_new = @'
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
'@

$r4_old = @'
  try { $res = $raw | ConvertFrom-Json } catch { Log '输出不是 JSON，重试' 'Yellow'; continue }
'@
$r4_new = @'
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
'@

$r5_old = @'
$estArea = [Math]::Max(480000, $compCount * 120000 + $connCount * 12000)
$estSide = [Math]::Ceiling([Math]::Sqrt($estArea))
if ($baseW * $baseH -lt $estArea) {
  Log ("板框偏小（{0}x{1}={2} mil² < 预估 {3} mil²），首轮即按预估放大" -f $baseW,$baseH,($baseW*$baseH),$estArea) 'DarkYellow'
'@
$r5_new = @'
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
'@

$r6_old = @'
if (-not $res -or -not $v) {
  Write-Host $raw
  throw "所有自愈策略均失败（无有效 JSON 结果）"
}
'@
$r6_new = @'
if (-not $res -or -not $v) {
  Write-Host $raw
  # 关键：不清会话就 throw，下一个设计会继承这个被幽灵调用占住/已失效的 session，
  # 于是「一个设计超时」会变成「后面所有设计都报非 JSON、策略=?」（实测 d7 -> d8）。
  Log '本设计未产出有效结果，废弃当前 session，避免污染后续设计' 'Red'
  try { & $CLI session abort --session $sid 2>&1 | Out-Null } catch { }
  Remove-Item $SessionFile -Force -ErrorAction SilentlyContinue
  throw "所有自愈策略均失败（无有效 JSON 结果）"
}
'@

Patch $ps $psNew @(
  @{ old = $r1_old; new = $r1_new; n = 1 }
  @{ old = $r2_old; new = $r2_new; n = 1 }
  @{ old = $r5_old; new = $r5_new; n = 1 }
  @{ old = $r3_old; new = $r3_new; n = 1 }
  @{ old = $r4_old; new = $r4_new; n = 1 }
  @{ old = $r6_old; new = $r6_new; n = 1 }
) | Out-Null

# run-all 里 4 处硬编码超时统一换成变量
$t = [IO.File]::ReadAllText($psNew)
$cnt = ([regex]::Matches($t, [regex]::Escape('--timeout 590000'))).Count
$t = $t.Replace('--timeout 590000', '--timeout $InvokeTimeoutMs')
[IO.File]::WriteAllText($psNew, $t, (New-Object Text.UTF8Encoding($false)))
Write-Host "[patch] run-all: 替换 --timeout 590000 x$cnt" -ForegroundColor Green

$errs = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($psNew, [ref]$null, [ref]$errs)
if ($errs -and $errs.Count) { $errs | ForEach-Object { Write-Host "  解析错误: $($_.Message)" -ForegroundColor Red }; throw "run-all 补丁语法错误" }
Write-Host "[patch] run-all.patched.ps1 语法 OK" -ForegroundColor Green

# ============================ 生成 unified diff ============================
# 为了让 patch 头是干净的 a/ b/ 相对路径（原路径含中文会被 git C-quote 成 \351\266…），
# 在 .patchwork\diff 下摆一份 a/ b/ 同构目录，再从那里比。
$diffOut = Join-Path $Root 'scripts\d7d8-patches.diff'
$diffRoot = Join-Path $Work 'diff'
Remove-Item $diffRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $diffRoot 'a\scripts'), (Join-Path $diffRoot 'b\scripts') | Out-Null
Copy-Item $js (Join-Path $diffRoot 'a\scripts\pipeline3.js')
Copy-Item $jsNew (Join-Path $diffRoot 'b\scripts\pipeline3.js')
Copy-Item $ps (Join-Path $diffRoot 'a\run-all.ps1')
Copy-Item $psNew (Join-Path $diffRoot 'b\run-all.ps1')

$out = @()
foreach ($rel in @('scripts/pipeline3.js', 'run-all.ps1')) {
  $txt = (& $Git -C $diffRoot -c core.quotePath=false diff --no-index --no-color --unified=3 -- "a/$rel" "b/$rel" 2>$null | Out-String)
  $txt = $txt.Replace('a/a/', 'a/').Replace('b/b/', 'b/')
  $out += $txt.TrimEnd()
}
Set-Content -Path $diffOut -Value (($out -join "`n`n") + "`n") -Encoding UTF8 -NoNewline
$sz = (Get-Item $diffOut).Length
$add = (Select-String -Path $diffOut -Pattern '^\+[^+]' -AllMatches).Count
$del = (Select-String -Path $diffOut -Pattern '^-[^-]' -AllMatches).Count
Write-Host ("[patch] diff -> scripts\d7d8-patches.diff ({0:N1} KB, +{1}/-{2} 行)" -f ($sz / 1KB), $add, $del) -ForegroundColor Green
