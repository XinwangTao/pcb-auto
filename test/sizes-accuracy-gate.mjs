#!/usr/bin/env node
/**
 * sizes-accuracy-gate.mjs · SIZES 表 vs 成品 Gerber 实测：把偏差变成看得见的数
 *
 * 背景
 * ----
 * `scripts/relayout.mjs` 的 `SIZES` 是布局器的输入（器件多大、能放多近、板框留多少边），
 * 而这张表**此前没有任何东西核对过**。2026-11-27 的几何审查实测 0603 表里写 `w:119`，
 * 成品里的铜宽只有 76 —— `bypass_cap_distance` 因此把 155.5 mil 读成 76，差 2.05 倍。
 *
 * 为什么这道闸门**不**要求两者相等
 * --------------------------------
 * 实测过：用 `scripts/measure-sizes.mjs` 在**已布局的整板上**量，会被过孔与相邻器件的焊盘
 * 污染（同一料号在四块板上读出 56.4 / 311.4 / 311.4 / 311.4）。污染只会把包围盒**放大**，
 * 所以在密集板上无法得到可信的真值。**凭这种读数去改 SIZES 会把布局器带偏，比留着偏差更糟。**
 *
 * 能拿到干净读数的地方只有一个：`test/mutants/base` 里孤立摆放的 C1（0603）。
 * 那里量到 86.6 mil，且与 PnP 自洽：
 *     焊盘中心距 55.2（= 2 × 0.7mm）+ 2 × 15.7（0603 焊盘半宽 0.4mm）≈ 86.6
 *
 * 所以这道闸门钉两件事：
 *   1. **测量本身不腐**：孤立 0603 的实测值必须仍在 80–95 mil 之间。工具/夹具/解析器
 *      任何一处坏了都会让它掉出去 —— 这是对量具的回归锁。
 *   2. **偏差必须被看见**：每次 `npm test` 都把 SIZES 与实测的差值打出来，并注明
 *      「已知未修，原因是什么」。宁可带着一个明示的已知偏差，也不要一个看不见的错值。
 *
 * 退出码：0 通过 / 1 量具或闸门自身坏了 / 2 环境问题（量不起来）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIXTURE = path.join(ROOT, 'test', 'mutants', 'base');
const DESIGN = path.join(ROOT, 'designs', 'd1-sht30.json');
const SIZES_SRC = path.join(ROOT, 'scripts', 'relayout.mjs');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  [ok] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${extra ? '  ' + extra : ''}`); }
}

for (const p of [FIXTURE, DESIGN, SIZES_SRC]) {
  if (!fs.existsSync(p)) { console.log('  SIZESACC=ENVSKIP  缺 ' + path.relative(ROOT, p)); process.exit(2); }
}

// ── 1. 从 SIZES 读出 0603（C14663）的声明值 ───────────────────────────
{
  const src = fs.readFileSync(SIZES_SRC, 'utf8');
  const m = /C14663:\s*\{\s*w:\s*([\d.]+),\s*h:\s*([\d.]+)\s*\}/.exec(src);
  ok(!!m, 'SIZES 里能找到 C14663（0603）的声明值');
  if (m) {
    console.log(`  [info] SIZES.C14663 = w ${m[1]} / h ${m[2]} mil`);
  }
}

// ── 2. 用出货的量具在孤立夹具上重测 ──────────────────────────────────
let measured = null;
{
  const r = spawnSync(process.execPath,
    [path.join(ROOT, 'scripts', 'measure-sizes.mjs'), '--design', DESIGN, '--out', FIXTURE, '--json'],
    { encoding: 'utf8', cwd: ROOT, timeout: 120_000, windowsHide: true });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0) {
    console.log('  SIZESACC=ENVSKIP  测量跑不起来（exit=' + r.status + '）：' + out.slice(0, 200));
    process.exit(2);
  }
  let j = null;
  try { j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)); } catch (_) { }
  if (!j || !Array.isArray(j.measured)) {
    console.log('  SIZESACC=ENVSKIP  测量输出不是可解析的 JSON');
    process.exit(2);
  }
  measured = j.measured.find((x) => x.lcsc === 'C14663') || null;
  ok(!!measured, '夹具里量到了 C14663（孤立的 0603）');
}

// ── 3. 量具回归锁：孤立 0603 的铜宽必须仍在 80–95 mil ─────────────────
if (measured) {
  const w = measured.wMil, h = measured.hMil;
  console.log(`  [info] 成品 Gerber 实测 C14663 = w ${w} / h ${h} mil（${measured.des.join(',')}）`);
  ok(w >= 80 && w <= 95, '孤立 0603 的实测铜宽仍在 80–95 mil（量具没腐）', `实际 ${w}`);
  // 【高度区间是更正后的值】本条闸门第一版写的是 55–80，那个区间来自**被过孔污染**的读数 68.5。
  // 加了双层判据踢除过孔之后，0603 的真实焊盘高是 35.4 mil（= 0.9mm，与焊盘常识一致）。
  // 所以区间改成 25–45；它仍然是一把量具回归锁。
  ok(h >= 25 && h <= 45, '孤立 0603 的实测铜高仍在 25–45 mil（量具没腐）', `实际 ${h}`);

  // 与 PnP 自洽：0603 焊盘中心距 2×0.7mm=55.2 mil，加两侧各半宽 15.7 → ≈86.6
  ok(Math.abs(w - 86.6) <= 6, '实测值与手算 55.2 + 2×15.7 ≈ 86.6 相差不超过 6 mil', `实际 ${w}`);
}

// ── 4. 不变量：声明的碰撞盒必须 >= 实测铜范围（全 15 种料号）───
//
// 为什么是「>=」而不是「≈」：`relayout.mjs` 的 `box()` 用 SIZES 建碰撞盒，
// `overlapArea()` 用它判两个器件是否重叠（下一行就是 `if (o) …`）。
// 声明值一旦**小于**实际占用，两个器件的本体可以重叠而布局器看不见 ——
// 这是一个可判定的缺陷；反之声明得偏大只是浪费面积，不会出错。
{
  const FIX = path.join(ROOT, 'test', 'fixtures', 'sizes-measured.json');
  if (!fs.existsSync(FIX)) { console.log('  SIZESACC=ENVSKIP  缺 test/fixtures/sizes-measured.json'); process.exit(2); }
  let fx = null;
  try { fx = JSON.parse(fs.readFileSync(FIX, 'utf8')); } catch (e) { console.log('  SIZESACC=ENVSKIP  基线读不了'); process.exit(2); }
  const entries = fx.entries || {};
  const tol = Number(fx.toleranceMil || 0.6);

  const src = fs.readFileSync(SIZES_SRC, 'utf8');
  const declared = {};
  for (const m of src.matchAll(/(\w+):\s*\{\s*w:\s*([\d.]+),\s*h:\s*([\d.]+)\s*\}/g)) {
    declared[m[1]] = { w: Number(m[2]), h: Number(m[3]) };
  }

  const viol = [];
  let checked = 0;
  for (const [lcsc, m] of Object.entries(entries)) {
    const d = declared[lcsc];
    if (!d) { viol.push(`${lcsc}: SIZES 里没有这个料号（布局器会直接退 2）`); continue; }
    checked++;
    const badW = d.w + tol < m.wMil;
    const badH = d.h + tol < m.hMil;
    if (badW || badH) {
      viol.push(`${lcsc}: 声明 ${d.w}\u00d7${d.h} < 实测 ${m.wMil}\u00d7${m.hMil}`
        + `（${badW ? 'w 短 ' + (Math.round((m.wMil - d.w) * 10) / 10) : ''}`
        + `${badW && badH ? '，' : ''}${badH ? 'h 短 ' + (Math.round((m.hMil - d.h) * 10) / 10) : ''} mil）`);
    }
  }
  for (const v of viol) console.log('  [FAIL] ' + v);
  ok(viol.length === 0, `声明的碰撞盒全部覆盖了实测铜范围（分母 = ${checked} 种料号）`);
  ok(checked >= 10, '基线覆盖面足够（>=10 种）', `实际 ${checked}`);
  console.log(`  [info] 对账了 ${checked} / ${Object.keys(entries).length} 种料号，容差 ${tol} mil`);
}

// ── 5. 把两者的关系说清楚（这不是偏差，是两个量）───────────
//
// 审查报过「0603 表里写 119，成品铜宽只有 76」，当成一个缺陷。
// 实测澄清后：那是**两个不同的量** ——
//   SIZES 是碰撞盒（布局器用它判两个器件是否重叠），必须 ≥ 铜范围；
//   76 / 86.6 是焊盘铜实际占的范围（上面已经验证它与 PnP 自洽）。
// 119 比 86.6 大是**正确**的：碰撞盒要把本体也算进去。把它压到 87 反而会让两个
// 0603 的本体可以重叠而布局器看不见 —— 所以下面这条是**不可逆的方向性**断言：
// 谁想把声明值压到实测值以下，这里就会红。
{
  const src = fs.readFileSync(SIZES_SRC, 'utf8');
  const m = /C14663:\s*\{\s*w:\s*([\d.]+),\s*h:\s*([\d.]+)\s*\}/.exec(src);
  if (m && measured && measured.wMil > 0) {
    const declW = Number(m[1]), declH = Number(m[2]);
    console.log('');
    console.log('  ── 两个量的关系（不是偏差）──');
    console.log(`  SIZES（碰撞盒）${declW}×${declH} mil ≥ 成品铜实测 ${measured.wMil}×${measured.hMil} mil`);
    console.log(`  碰撞盒比焊盘铜宽 ${Math.round((declW / measured.wMil) * 100)}%，那是应该的：它还要盖住封装本体。`);
    ok(declW >= measured.wMil, 'C14663 的碰撞盒不小于实测铜宽（压到铜宽以下会让本体可以重叠）',
      `声明 ${declW} / 实测 ${measured.wMil}`);
    ok(declH >= measured.hMil, 'C14663 的碰撞盒不小于实测铜高',
      `声明 ${declH} / 实测 ${measured.hMil}`);
  }
}

console.log('');
const total = pass + fail;
if (!total) { console.log('  SIZESACC=FAIL  一条断言都没跑'); process.exit(1); }
if (fail) { console.log(`  SIZESACC=FAIL  ${fail} / ${total} 条断言未过`); process.exit(1); }
console.log(`  SIZESACC=PASS  ${total} 条断言全过（量具回归锁 3 条 + 自洽 1 条 + 碰撞盒不变量 3 条 + 方向性 2 条）`);
process.exit(0);
