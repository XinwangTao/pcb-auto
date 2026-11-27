#!/usr/bin/env node
'use strict';
/**
 * test/fabcheck-selftest.mjs —— 把 `fabcheck --selftest` 接进闸门链。
 *
 * 为什么需要这个包装器：
 *   `--selftest` 一直是**坏的**，而且坏了很久没人发现，因为它不在 `npm test` 里。
 *   一个不跑的测试不是测试。实测（2026-11-26T19:43）它红在
 *   「坏样本命中 gerber.mask.top.empty」——根因是故障注入只剥掉了 GTS 的 153 条 D03，
 *   而那条判据判的是「0 图元」，剥完还剩 606 条 D01 + 6 个 G36 区域 = 612，
 *   判据当然不响。换句话说：**自检红的原因跟被测对象无关**，这比没有自检更坏 ——
 *   它会教人把这条闸门当噪音。
 *
 * 退出码契约（与 test/ 下其它闸门一致）：
 *   0 = 自检通过（坏样本被判红、好样本被判绿）
 *   1 = 自检**发现**了问题（fabcheck 的行为不再符合它自己声明的契约）
 *   2 = 环境问题（缺样本 / 跑不起来）—— 不能归到 1，否则没人分得清
 *       「我的代码坏了」和「这台机器上没有样本」
 *
 * 样本用版本化的 test/mutants/base，不用 out/ 下的运行产物：
 *   out/ 会被 cleanup.ps1 清理，而闸门不能依赖一个会被删掉的东西。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FAB = path.join(ROOT, 'scripts', 'fabcheck.js');
const BASE = path.join(ROOT, 'test', 'mutants', 'base');

const need = [FAB, path.join(BASE, 'Gerber.zip'), path.join(BASE, 'PnP.csv'), path.join(BASE, 'BOM.xlsx')];
const missing = need.filter((p) => !fs.existsSync(p));
if (missing.length) {
  console.error(`FABCHECK-SELFTEST=NOSAMPLE 缺输入：${missing.map((p) => path.relative(ROOT, p)).join(', ')}`);
  process.exit(2);
}

let out, code;
try {
  out = execFileSync(process.execPath, [FAB, '--selftest', BASE], {
    encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  code = 0;
} catch (e) {
  // 退出码 1 是「自检发现了失败」，stdout 里仍有完整报告 —— 要读它，不要当成跑不起来。
  out = e.stdout || '';
  code = typeof e.status === 'number' ? e.status : 2;
  if (!String(out).trim()) {
    console.error(`FABCHECK-SELFTEST=NOSAMPLE 自检没产出任何 stdout（status=${code}）：${String(e.stderr || e.message).slice(0, 400)}`);
    process.exit(2);
  }
}

let j = null;
try { j = JSON.parse(out); } catch (_) {
  console.error(`FABCHECK-SELFTEST=NOSAMPLE 输出不是 JSON：${String(out).slice(0, 300)}`);
  process.exit(2);
}

/* ──────────────── 【自己测，不信自述】 ────────────────
 * 实测 2026-11-27（对抗性审查）：把 fabcheck 的 selftest() 换成「常量返回 PASS」，
 * 这道闸门**仍然 PASS**，而且把从 JSON 里读到的 exitGood/exitBad
 * 直接印成「证据」—— 那两个退出码从来没被测量过。
 * 一个只复述被测对象结论的闸门，等于没有闸门。
 *
 * 现在自己跑两次：好样本必须 exit 0、坏样本必须 exit 1；
 * 并把**自述值与实测值对账** —— 自述报一个没发生过的数字也要红。
 * 坏样本用最硬的一种：把 Gerber.zip 清零（对应 file.empty / gerber.zip.invalid）。
 */
function runFab(dir) {
  try {
    const o = execFileSync(process.execPath, [FAB, dir], {
      encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out: String(o) };
  } catch (e) {
    // fabcheck 把 FAIL 报告写 stderr，所以两边都要收
    return { code: typeof e.status === 'number' ? e.status : 2, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

const badDir = path.join(ROOT, 'out', `_fabcheck-bad-${process.pid}`);
let measuredGood = null;
let measuredBad = null;
try {
  fs.rmSync(badDir, { recursive: true, force: true });
  fs.mkdirSync(badDir, { recursive: true });
  fs.cpSync(BASE, badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, 'Gerber.zip'), Buffer.alloc(0));

  const g = runFab(BASE);
  const b = runFab(badDir);
  measuredGood = g.code;
  measuredBad = b.code;

  const mism = [];
  if (g.code !== 0) mism.push(`好样本实测 exit=${g.code}，期望 0`);
  if (b.code !== 1) mism.push(`坏样本实测 exit=${b.code}，期望 1`);
  if (j && typeof j.exitGood === 'number' && j.exitGood !== g.code) {
    mism.push(`自述 exitGood=${j.exitGood} 与实测 ${g.code} 不符`);
  }
  if (j && typeof j.exitBad === 'number' && j.exitBad !== b.code) {
    mism.push(`自述 exitBad=${j.exitBad} 与实测 ${b.code} 不符`);
  }
  if (mism.length) {
    console.error('  FABCHECK-SELFTEST=FAIL 独立测量与自述不一致：');
    for (const m of mism) console.error('      ✗ ' + m);
    process.exit(1);
  }
} finally {
  try { fs.rmSync(badDir, { recursive: true, force: true }); } catch (_) { }
}

if (code === 0 && j.selftest === 'PASS') {
  const cases = j.cases || [];
  const neg = cases.filter((c) => c.ok).length;
  // 分母要写清：断言里有几条是「坏样本必须命中」、几条是「好样本必须绿」。
  // 只报「PASS」而不说判了几条，等于没有分母的结论。
  if (!neg) {
    console.error('FABCHECK-SELFTEST=NOSAMPLE 自检报 PASS 但一条断言都没有 —— 空集不能算通过');
    process.exit(2);
  }
  // 【断言条数棘轮】只要有一条 case 就算通过的话，
  // 把 selftest() 换成「返回 {selftest:'PASS', cases:[{ok:true}]}」的常量就能绕过。
  // 18 是 2026-11-27 实测值（只许升不许降），不是目标值。
  const MIN_CASES = 18;
  if (neg < MIN_CASES) {
    console.error('  FABCHECK-SELFTEST=FAIL 自检断言从 ' + MIN_CASES + ' 条降到 ' + neg + ' 条 —— 棘轮被破，少检就等于放宽闸门');
    process.exit(1);
  }
  // 报**实测**值，不报自述值。
  console.log(`  FABCHECK-SELFTEST=PASS ${neg} 条断言全过（实测：好样本 exit=${measuredGood} / 坏样本 exit=${measuredBad}，且与自述一致）`);
  console.log('                          样本 test/mutants/base（版本化，不依赖会被清理的 out/）');
  process.exit(0);
}

// 走到这里 = 自检判了自己红。这是「发现失败」，不是环境问题。
const why = j.error || '未知';
console.error(`  FABCHECK-SELFTEST=FAIL exit=${code}：${why}`);
for (const c of (j.cases || [])) if (!c.ok) console.error(`      ✗ ${c.msg}`);
process.exit(1);
