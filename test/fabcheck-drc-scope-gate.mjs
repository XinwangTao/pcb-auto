#!/usr/bin/env node
/**
 * fabcheck-drc-scope-gate.mjs · fabcheck 必须把「DRC 自述」纳入判决，并且说清它不查什么
 *
 * 缺陷（2026-11-27 对抗性审查）
 * ----------------------------
 * 三块**已被作废**的板（含 `drcLeafCount:2` 的 `ESP32S3_Wireless_Mic_V5-20261126-214236`）
 * 跑 fabcheck **全是 exit 0 / 0 阻断**。根因不是判据写错，是它**根本没读 DRC** ——
 * `_run.json` 只被用来核对板框尺寸。
 *
 * 而 `fabcheck` 被文档写成「能不能下单的唯一权威」。于是一块电气上还有 2 条叶子的板，
 * 会拿到一份 `verdict: PASS` 的报告。
 *
 * 修法（两条，方向相反但互补）
 * ----------------------------
 * 1. **单向加严**：自述 `gates.drcLeafCount > 0` ⇒ 阻断 `drc.leaves.open`。
 *    只用「有叶子」去否决，绝不用「没叶子」去背书 —— 否则独立复核就被生产者的话替代了。
 * 2. **常驻声明**：永远发一条 `scope.electrical`，明说本闸门不查电气间距/短路/连通性。
 *    读的人不能把 PASS 读成「没有短路」。
 *
 * 另外：`_run.json` 在但缺 `gates.drcLeafCount` 时发 `run.drc.missing` 提醒 ——
 * 「这一维没有读数」不许沉默。
 *
 * 退出码：0 通过 / 1 发现了失败 / 2 环境问题
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASE = path.join(ROOT, 'test', 'mutants', 'base');
const FAB = path.join(ROOT, 'scripts', 'fabcheck.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  [ok] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${extra ? '  ' + extra : ''}`); }
}

for (const p of [BASE, FAB]) {
  if (!fs.existsSync(p)) { console.log('  FABDRC=ENVSKIP  缺 ' + path.relative(ROOT, p)); process.exit(2); }
}

function runFab(dir) {
  const r = spawnSync(process.execPath, [FAB, dir], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
  const raw = (r.stdout || '') + (r.stderr || '');
  let j = null;
  const i0 = raw.indexOf('{'), i1 = raw.lastIndexOf('}');
  if (i0 >= 0 && i1 > i0) { try { j = JSON.parse(raw.slice(i0, i1 + 1)); } catch (_) { } }
  return { code: r.status, json: j, raw };
}

function mkCase(name, runJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabdrc-'));
  for (const f of fs.readdirSync(BASE)) {
    fs.copyFileSync(path.join(BASE, f), path.join(dir, f));
  }
  if (runJson !== null) {
    fs.writeFileSync(path.join(dir, '_run.json'), JSON.stringify(runJson), 'utf8');
  }
  return { name, dir };
}
const cleanup = [];
const C = (n, rj) => { const c = mkCase(n, rj); cleanup.push(c.dir); return c; };

try {
  const ids = (j, k) => new Set(((j && j[k]) || []).map((x) => x && x.id).filter(Boolean));

  // ── A. 没有 _run.json：通过，但必须带上「本闸门不查电气」的声明 ──────────
  {
    const c = C('no-runjson', null);
    const r = runFab(c.dir);
    ok(r.code === 0, 'A 没有 _run.json 时夹具本身仍通过（否则下面的断言没有对照）', `exit=${r.code}`);
    ok(ids(r.json, 'notes').has('scope.electrical'), 'A 永远发 scope.electrical 声明（PASS 不能被读成「没短路」）');
    ok(!ids(r.json, 'blockers').has('drc.leaves.open'), 'A 没有 DRC 读数时**不**编一个阻断出来');
  }

  // ── B. 自述 drcLeafCount=2：必须阻断 ───────────────────────────────────
  {
    const c = C('leaves-2', {
      designName: 'X', boardWidthMil: 800, boardHeightMil: 600, ok: false,
      gates: { drcLeafCount: 2, drcTotalCount: 2, drcPassed: false },
    });
    const r = runFab(c.dir);
    ok(r.code === 1, 'B 自述 2 条叶子 ⇒ exit 1（这才是「不能下单」）', `exit=${r.code}`);
    ok(ids(r.json, 'blockers').has('drc.leaves.open'), 'B 阻断里点名 drc.leaves.open');
    ok(r.json && r.json.verdict === 'FAIL', 'B verdict 是 FAIL');
  }

  // ── C. 自述 0 叶子：不得因此多出「通过」的证据（单向）─────────────────
  {
    const c = C('leaves-0', {
      designName: 'X', boardWidthMil: 800, boardHeightMil: 600, ok: true,
      gates: { drcLeafCount: 0, drcTotalCount: 0, drcPassed: true },
    });
    const r = runFab(c.dir);
    ok(r.code === 0, 'C 自述 0 叶子时 exit 0', `exit=${r.code}`);
    ok(!ids(r.json, 'blockers').has('drc.leaves.open'), 'C 0 叶子时不阻断');
    // 关键：不许把「生产者说 0」变成一条 pass 证据
    const passIds = [...ids(r.json, 'passes')];
    ok(!passIds.some((x) => /drc/i.test(x) && !/scope/i.test(x)),
      'C **不**因自述 0 叶子而新增任何 drc 相关的 pass 记录（否则独立性就没了）', passIds.join(','));
  }

  // ── D. 有 _run.json 但没有 gates：必须提醒也没有读数 ─────────────────
  {
    const c = C('no-gates', { designName: 'X', boardWidthMil: 800, boardHeightMil: 600, ok: true });
    const r = runFab(c.dir);
    ok(ids(r.json, 'warnings').has('run.drc.missing'), 'D 缺 gates.drcLeafCount 时发 run.drc.missing 提醒（沉默不行）');
    ok(!ids(r.json, 'blockers').has('drc.leaves.open'), 'D 但也不编阻断');
  }
} finally {
  for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { } }
}

console.log('');
const total = pass + fail;
if (!total) { console.log('  FABDRC=FAIL  一条断言都没跑'); process.exit(1); }
if (fail) { console.log(`  FABDRC=FAIL  ${fail} / ${total} 条断言未过`); process.exit(1); }
console.log(`  FABDRC=PASS  ${total} 条断言全过（4 场景：无自述 / 有叶子 / 零叶子 / 无 gates 字段）`);
process.exit(0);
