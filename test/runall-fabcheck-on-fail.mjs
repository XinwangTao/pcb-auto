#!/usr/bin/env node
// 闸门：run-all.ps1 在**失败分支**里必须问一次「能不能下单」，而且只记录、不改判定。
//
// 为什么需要这道闸门：
//   `run-all.ps1` 的 fabcheck 调用点（约 L984）在 `if (-not $v.ok)` 的**成功分支**里，
//   而失败分支报完 DRC 类型就 `continue`（约 L880）。于是对 ok=false 的每一次尝试，
//   「这块板现在拿去下单会怎样」从头到尾没有被测量过 —— 麦克风板至今每次尝试都是
//   ok=false，它的下单资格一次都没被问过；fabcheck 里那些只有在产物上才看得见的判据
//   （例如 antenna.keepout.copper：在最终铜层上实测天线净空带有没有铜）也一次都没跑过。
//
// 这道闸门钉三件事：
//   1. 那个块真的在跑 fabcheck（含「拿不到 JSON」「调用异常」两种非判定路径）；
//   2. 它**只记录**：块内不许出现 $finalOk，且必须仍然 `continue`（不许掉进成功路径）；
//   3. 数阻断不许用 `@($x).Count` —— 空数组经 ConvertFrom-Json 后是 $null，
//      而 `@($null).Count` 是 **1**，会把一块 0 阻断的好板读成「1 项阻断」。
//
// 退出码契约：0 通过 / 1 发现失败 / 2 环境问题。
//   ★ 2 **只**留给「这台机器上量不了」：读不到 run-all.ps1、没有 pwsh。
//   ★ 凡是 run-all.ps1 的**内容**不满足契约（块不在、判据缺失、写错读法）一律 1。
//     这条界线是踩出来的：本闸门最初的版本把 `summary.blockers` 同时放进
//     「定位前置条件」和「判据」两处，前置先触发 —— 于是把一个真实的缺陷
//     （有人把读法换回 `@($json.blockers).Count`）报成了 exit 2「锚点对不上，闸门不成立」。
//     对一个红文件说「我没能测量」，等于让一次失败伪装成环境故障，
//     而这两种情况的处置完全相反。前置条件只放**定位**用的针（fabcheck.js / ConvertFrom-Json /
//     continue），判据只放 chk()。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RUNALL = path.join(ROOT, 'run-all.ps1');

// 2 = 这台机器上量不了。**只有** I/O 与工具缺失走这里。
function bail(msg) { console.log('  RUNALL-FABCHECK=ENVSKIP  ' + msg); process.exit(2); }
// 1 = run-all.ps1 的内容不满足契约。块不在、判据不在，都是失败，不是环境问题。
function contractFail(msg) {
  console.log('  RUNALL-FABCHECK=FAIL  ' + msg);
  process.exit(1);
}

let src;
try { src = fs.readFileSync(RUNALL, 'utf8'); }
catch (e) { bail(`读不到 ${path.relative(ROOT, RUNALL)}：${e.message}`); }

const START = '$fabcheckAudit = $null';
const a = src.indexOf(START);
if (a < 0) contractFail(`找不到起锚点「${START}」—— 失败分支里没有「问一次下单资格」这段（契约要求它必须存在）`);
if (src.indexOf(START, a + 1) >= 0) contractFail('起锚点出现多次，无法确定抽哪一段');

// 止点：起锚点之后、缩进 4 空格的那个 `continue`
const END = /\r?\n {4}continue\r?\n/.exec(src.slice(a));
if (!END) contractFail('起锚点之后找不到 4 空格缩进的 continue —— 这段必须仍然 continue');
const block = src.slice(a, a + END.index + END[0].length);

// 抽到的必须真是那段逻辑，否则闸门在验空气。
// ★ 这里只放**定位针**（出现即证明「我抽对了段」）；判据一律走下面的 chk()。
//   `summary.blockers` 故意**不**在这里：它是判据，把它放这儿会让「读法被改坏」
//   被报成「锚点对不上」，而两者处置相反。
for (const needle of ["fabcheck.js", 'ConvertFrom-Json', 'continue']) {
  if (!block.includes(needle)) contractFail(`抽到的块里没有 ${needle} —— 抽错段了，闸门在验空气`);
}

const fails = [];
let pass = 0;
const chk = (cond, label) => { if (cond) pass++; else fails.push(label); };

// ── 静态：只记录，不改判定 ─────────────────────────────────────────────────
chk(!/\$finalOk/.test(block), '块内不得出现 $finalOk —— 诊断读数不许参与本轮通过与否');
chk(!/exit\s+\d/.test(block), '块内不得 exit —— 它只记录，不替流水线做终判');
chk(/continue/.test(block), '块末尾必须仍然 continue（掉进成功路径会把失败尝试当通过）');
chk(!/\.blockers\)\.Count|\.warnings\)\.Count/.test(block),
  '不得用 @($json.blockers).Count 数阻断 —— 空数组会是 $null，@($null).Count==1，0 阻断被读成 1');
chk(/summary\.blockers/.test(block), '必须取 fabcheck 自己算好的 summary.blockers 计数');

// ── 动态：把真实块嵌进 stub 跑 ─────────────────────────────────────────────
const pwsh = process.env.PCB_AUTO_PWSH
  || ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'pwsh'].find((p) => {
    try { execFileSync(p, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }); return true; }
    catch { return false; }
  });
if (!pwsh) bail('找不到 pwsh 7 —— 无法嵌入执行（这条闸门不能用「跳过」冒充通过）');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runall-fab-'));
const fakeRoot = path.join(tmp, 'repo');
fs.mkdirSync(path.join(fakeRoot, 'scripts'), { recursive: true });
const outDir = path.join(tmp, 'out');
fs.mkdirSync(outDir, { recursive: true });

// 桩：按 FAB_MODE 给出四种**真实存在**的形态（不是猜的）
fs.writeFileSync(path.join(fakeRoot, 'scripts', 'fabcheck.js'), `
const mode = process.env.FAB_MODE;
const emit = (o, code) => { console.log(JSON.stringify(o, null, 2)); process.exit(code); };
if (mode === 'ok')     emit({ tool:'fabcheck', verdict:'PASS', exit:0,
  summary:{blockers:0, warnings:4, notes:5, passes:14}, blockers:[], warnings:[{}] , notes:[], passes:[] }, 0);
if (mode === 'block')  emit({ tool:'fabcheck', verdict:'FAIL', exit:1,
  summary:{blockers:2, warnings:1, notes:0, passes:9},
  blockers:[{id:'gerber.coord.outside'},{id:'antenna.keepout.copper'}], warnings:[{}], notes:[], passes:[] }, 1);
if (mode === 'nonjson') { console.log('not json at all'); process.exit(0); }
if (mode === 'boom')   { console.error('突发的内部错误'); process.exit(2); }
`, 'utf8');

const NODE = process.env.PCB_AUTO_NODE || process.execPath;

function runCase(mode) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$logLines = New-Object System.Collections.ArrayList',
    'function Log($m, $c) { [void]$logLines.Add([string]$m) }',
    `$Root = ${psStr(fakeRoot)}`,
    `$OutDir = ${psStr(outDir)}`,
    `$nodeVerify = ${psStr(NODE)}`,
    'foreach ($__i in 1) {',
    block.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n').replace(/^/gm, '').split('\r\n').map((l) => (l ? '  ' + l : l)).join('\r\n'),
    '    Write-Output "SHOULD-NOT-REACH"',
    '  }',
    'Write-Output "AFTER-LOOP"',
    '$logLines | ForEach-Object { Write-Output ("LOG:" + $_) }',
    'if ($null -ne $fabcheckAudit) { Write-Output ("AUDIT:" + ($fabcheckAudit | ConvertTo-Json -Compress)) }',
    'else { Write-Output "AUDIT:<null>" }',
  ].join('\r\n');
  const file = path.join(tmp, 'case.ps1');
  fs.writeFileSync(file, '\uFEFF' + script, 'utf8');
  const out = execFileSync(pwsh, ['-NoProfile', '-File', file], {
    encoding: 'utf8', env: { ...process.env, FAB_MODE: mode }, timeout: 120000,
  });
  return out;
}

function psStr(s) { return `'${String(s).replace(/'/g, "''")}'`; }

function lines(out, prefix) {
  return out.split(/\r?\n/).filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length));
}

// 1. 好板（0 阻断）—— 靶心：不许报成「1 项阻断」
{
  const out = runCase('ok');
  const aud = lines(out, 'AUDIT:')[0] || '';
  chk(!out.includes('SHOULD-NOT-REACH'), '[ok] 块必须仍然 continue，不许掉进成功路径');
  chk(out.includes('AFTER-LOOP'), '[ok] continue 之后循环必须正常结束（没有死循环）');
  chk(/"blockers":0/.test(aud), '[ok] 0 阻断必须记成 0（@($null).Count 那个坑会给出 1）');
  chk(/"blockerIds":\[\]/.test(aud), '[ok] 0 阻断时 blockerIds 必须为空数组');
  chk(/"warnings":4/.test(aud), '[ok] 警告数必须取 summary.warnings=4');
  chk(/diagnostic-only/.test(aud), '[ok] 必须标注 scope=diagnostic-only（否则读者会以为它影响判定）');
  chk(!/阻断 id/.test(out), '[ok] 0 阻断不得打印阻断 id');
}

// 2. 真阻断 —— 必须把 id 打出来（只报数字会丢掉原因）
{
  const out = runCase('block');
  const aud = lines(out, 'AUDIT:')[0] || '';
  chk(/"blockers":2/.test(aud), '[block] 阻断数必须为 2');
  chk(/antenna\.keepout\.copper/.test(out), '[block] 必须打印阻断 id（丢消息只剩计数等于没报）');
  chk(/gerber\.coord\.outside/.test(out), '[block] 两个阻断 id 都要有');
  chk(!out.includes('SHOULD-NOT-REACH'), '[block] 阻断时也不许掉进成功路径');
}

// 3. 输出不是 JSON —— 未取得判定，不许当成「0 阻断」
{
  const out = runCase('nonjson');
  const aud = lines(out, 'AUDIT:')[0] || '';
  chk(/未取得/.test(out), '[nonjson] 必须明说未取得判定');
  chk(!/"verdict":"PASS"/.test(aud), '[nonjson] 不许编出一个 PASS');
  chk(/未取得判定/.test(aud), '[nonjson] scope 必须写明未取得判定');
  chk(!out.includes('SHOULD-NOT-REACH'), '[nonjson] 仍必须 continue');
}

// 4. fabcheck 自己崩了（exit 2）—— 与「不合格」分开
{
  const out = runCase('boom');
  chk(!out.includes('SHOULD-NOT-REACH'), '[boom] 仍必须 continue');
  const aud = lines(out, 'AUDIT:')[0] || '';
  chk(/"exitCode":2/.test(aud), '[boom] 必须记下 exitCode=2，与 exit 1（有阻断）区分开');
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 留不下就算了，别盖住真结论 */ }

if (fails.length) {
  console.log(`  RUNALL-FABCHECK=FAIL  ${fails.length} 条断言失败（共 ${pass + fails.length}）`);
  for (const f of fails) console.log('    ✗ ' + f);
  process.exit(1);
}
console.log(`  RUNALL-FABCHECK=PASS  ${pass} 条断言全过（4 个场景：好板 0 阻断 · 真阻断带 id · 输出非 JSON · fabcheck 崩溃）`);
