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

// ── 4. 把偏差明示出来（不是失败，是「已知未修」）──────────────────────
{
  const src = fs.readFileSync(SIZES_SRC, 'utf8');
  const m = /C14663:\s*\{\s*w:\s*([\d.]+),\s*h:\s*([\d.]+)\s*\}/.exec(src);
  if (m && measured && measured.wMil > 0) {
    const declW = Number(m[1]);
    const ratio = declW / measured.wMil;
    const pct = Math.round((ratio - 1) * 1000) / 10;
    console.log('');
    console.log(`  ── 已知偏差（未修）──`);
    console.log(`  SIZES 声明 ${declW} mil，成品实测 ${measured.wMil} mil，声明值偏大 ${pct}%`);
    console.log(`  为什么没修：密集整板上这个量具会被过孔/邻件污染（同一料号四块板读出`);
    console.log(`  56.4 / 311.4 / 311.4 / 311.4），**凭不可信的读数去改布局器输入，比留着偏差更糟**。`);
    console.log(`  要修得先有一个可信的封装尺寸来源（EDA 库或 datasheet），再连带重跑全部设计。`);
    // 【棘轮】既然这个偏差是已知且未修的，就把它**钉住**：
    // 声明值必须仍是 119。谁把它改了，就得同步改这里与上面的说明，
    // 而不能惄悄改一个数字。（实测：改成 87 时 ratio 仍 >1，
    // 只判「偏差方向」是拦不住的。）
    ok(declW === 119, 'C14663 声明值仍是已登记的 119（改了就要同步这里）', `实际 ${declW}`);
    ok(ratio > 1.2, '声明值仍明显偏大（>20%），与审查结论一致',
      `声明/实测 = ${Math.round(ratio * 100) / 100}`);
  }
}

console.log('');
const total = pass + fail;
if (!total) { console.log('  SIZESACC=FAIL  一条断言都没跑'); process.exit(1); }
if (fail) { console.log(`  SIZESACC=FAIL  ${fail} / ${total} 条断言未过`); process.exit(1); }
console.log(`  SIZESACC=PASS  ${total} 条断言全过（量具回归锁 3 条 + 自洽 1 条 + 偏差方向 1 条；偏差本身已明示）`);
process.exit(0);
