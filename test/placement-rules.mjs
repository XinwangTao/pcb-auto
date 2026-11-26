#!/usr/bin/env node
// 摆放判据的自检闸门 —— 证明 `scripts/audit-placement.mjs` **会失败，也只会为自己失败**。
//
// 退出码：0 通过 / 1 发现失败 / 2 环境问题（跑不起来，不是判据坏了）
//
// ── 为什么必须单独有这么一个文件 ────────────────────────────────────
// 这个仓库最贵的一条教训是「不会失败的测试不是测试」。已经踩过三次同形状：
//   · `doc-refs` 只验「这一行非空」，于是 56 处引用整体错位 70 行它还是绿的
//   · `syntax-gate` 把 100 多个 `.md`/`.json` 算进「全部通过」的分母
//   · `census` 在没有任何产物时靠读旧报告报出「56 个目录 / 53 可下单」
//
// `audit-placement.mjs` 刚写出来时**自己就有三个 bug 让它几乎不会失败**：
//   ① `all_inside_board` 用 `Math.min` 把天线夹到板外而不是夹进板内 → U1 恒报出界
//   ② `connector_at_edge` 的下方距边写成 `-H - y0`，对 `y0<0` 恒为负
//      → **任何器件都通过**（负数必然 ≤ 阈值），却还打印着「离边 -946 mil」这种
//      看起来专业的实测数字
//   ③ `--sizes` 的值被当成位置参数；没有 `--sizes` 时连设计路径本身都被排除
// ②是「永不失败」最典型的形状：判据在、结论在、数字在，只是没有一个输入能让它报错。
//
// ── 每条判据两种变异，缺一不可 ──────────────────────────────────────
//   A. 定向变异（sensitivity）——把这条判据对应的几何改坏，它**必须**翻成不通过。
//   B. 阴性对照（specificity）——只轻推一个无关的坐标，它**必须**保持基线结论。
//      没有 B，「规则响应自己的条件」和「规则在乱炸」分不开。
//
// ── 为什么不要求「其余判据不许变」──────────────────────────────────
// 第一版这么要求，11 项里红了 8 项，而红的全是 `no_bbox_overlap` —— 那是我把器件
// 丢到了已被占用的坐标，是**我的变异太钝**，不是判据不灵敏。把「连带翻红」当失败，
// 测的其实是「我的测试坐标选得好不好」。
// 所以：variant 只认目标判据是否翻；特异性交给同一条判据的阴性对照去证。
// 连带结果照实打印（`附带` 列），它是信息不是判决。
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const AUDIT = path.join(ROOT, 'scripts', 'audit-placement.mjs');
const DESIGN = path.join(ROOT, 'designs', 'mic-esp32s3-v3.json');

const fail = [];
const note = (m) => console.log('  ' + m);

function runAudit(designPath) {
  let out;
  try {
    out = execFileSync(process.execPath, [AUDIT, designPath, '--json'], {
      encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // 退出码 1/2 也会走到这里 —— stdout 里仍有完整 JSON，不算"跑不起来"。
    if (!e.stdout || !String(e.stdout).trim()) {
      return { spawnError: `审计没能产出任何 stdout（status=${e.status}）：${String(e.stderr || e.message).slice(0, 300)}` };
    }
    out = e.stdout;
  }
  try {
    return JSON.parse(out);
  } catch (e) {
    return { spawnError: `审计的 stdout 不是 JSON：${String(out).slice(0, 200)}` };
  }
}

const verdicts = (r) => Object.fromEntries((r.rules || []).map((x) => [x.id, x.verdict]));

if (!fs.existsSync(AUDIT)) { console.error(`PLACEMENT-RULES=NOSAMPLE 找不到 ${AUDIT}`); process.exit(2); }
if (!fs.existsSync(DESIGN)) { console.error(`PLACEMENT-RULES=NOSAMPLE 找不到 ${DESIGN}`); process.exit(2); }

const base = runAudit(DESIGN);
if (base.spawnError) { console.error(`PLACEMENT-RULES=NOSAMPLE ${base.spawnError}`); process.exit(2); }
const baseV = verdicts(base);
note(`基线 ${base.design}：${base.summary.total} 条判据，通过 ${base.summary.pass} / 不通过 ${base.summary.fail} / 无法判定 ${base.summary.unknown}，exit=${base.exitCode}`);

// ── 用例表 ───────────────────────────────────────────────────────────
// rule     被测判据
// want     定向变异后该判据应有的 verdict（'fail' 或 'pass'）
// mutate   定向变异（改坏 / 修好这条判据对应的几何）
// control  阴性对照：只轻推无关几何，该判据必须保持基线结论
const CASES = [
  {
    rule: 'connector_at_edge', want: 'fail',
    why: 'USB1 从左边 70 mil 挪到板中间 → 插头进不来',
    mutate: (d) => { d._placement.USB1.x = 650; d._placement.USB1.y = -1800; },
    control: (d) => { d._placement.USB1.y = -2550; },   // 沿边轻推 10 mil，仍贴边
  },
  {
    rule: 'antenna_band_empty', want: 'fail',
    why: '把麦克风 U4 挪进天线净空带 → Espressif 明令禁止元件侵入',
    mutate: (d) => { d._placement.U4.x = 650; d._placement.U4.y = -3694; },
    control: (d) => { d._placement.U4.y = -185; },      // 原地轻推 5 mil
  },
  {
    rule: 'band_covers_antenna', want: 'fail',
    why: '把带子上界退回 -3692（就是修之前那个值）→ 天线内缘留 2 mil 裸露缝',
    mutate: (d) => { d._antennaKeepout.y1 = -3692; },
    control: (d) => { d._placement.C1.x = 434; },       // 改无关器件
  },
  {
    rule: 'all_inside_board', want: 'fail',
    why: '把 R1 挪到板左外侧 → 焊盘不可焊',
    mutate: (d) => { d._placement.R1.x = -200; },
    control: (d) => { d._placement.R1.x = 655; },       // 板内轻推 5 mil
  },
  {
    rule: 'no_bbox_overlap', want: 'fail',
    why: '把 C5 收到 C4 的坐标上 → 物理上不可能同时贴装',
    mutate: (d) => { d._placement.C5.x = d._placement.C4.x; d._placement.C5.y = d._placement.C4.y; },
    control: (d) => { d._placement.D1.y = -455; },      // 无关器件轻推 5 mil
  },
  {
    rule: 'antenna_overhang', want: 'fail',
    why: '把 U1 上移到 -2900 → 天线尖端缩进板内 144 mil',
    mutate: (d) => { d._placement.U1.y = -2900; },
    control: (d) => { d._placement.U1.y = -3326; },     // 再往外挪 10 mil，悬出更多
  },
  {
    // 方向很重要：这条判据**基线就是不通过**（USB1 在 69% 处），
    // 所以有意义的定向变异只能是「挪到端部、必须转绿」。
    // 第一版写成 want:'fail'，而基线已经是 fail —— 那条断言恒成立，什么都没证明。
    // 下面的空洞守卫会拦住这种写法。
    rule: 'usb_at_end', want: 'pass',
    why: '【反向】把 USB1 挪到 y=-200（5.4% 处）→ 到端部，判据必须转绿',
    mutate: (d) => { d._placement.USB1.y = -200; },
    control: (d) => { d._placement.USB1.y = -2550; },   // 仍在 69%，结论应维持不通过
  },
  {
    rule: 'buttons_centered', want: 'fail',
    why: '把三个用户按键全部挪到 x=200 → 均位偏离中线 450 mil',
    mutate: (d) => { for (const k of ['SW1', 'SW2', 'SW3']) d._placement[k].x = 200; },
    control: (d) => { d._placement.SW1.x = 300; },      // 单键轻推 1 mil
  },
  // ── 反向对照：基线里不通过，修好后必须变通过 ──
  {
    rule: 'imu_near_centerline', want: 'pass',
    why: '【反向】把 U5 挪到板中线上 → 偏轴 0，判据必须转绿',
    mutate: (d) => { d._placement.U5.x = 650; },
    control: (d) => { const p = d._placement.U5; p.x = Number(p.x) + 5; },  // 仍偏轴 320，维持不通过
  },
  {
    rule: 'mic_speaker_apart', want: 'pass',
    why: '【反向】把扬声器排针 H1 挪到 y=-3400 → 与麦克风 3220 mil > 50 mm',
    mutate: (d) => { d._placement.H1.y = -3400; },
    control: (d) => { d._placement.H1.y = -1255; },    // 轻推 5 mil，仍 < 50 mm
  },
];

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'place-rules-'));
const results = [];
let n = 0;

const applyCase = (c, kind) => {
  const d = JSON.parse(fs.readFileSync(DESIGN, 'utf8'));
  (kind === 'mutate' ? c.mutate : c.control)(d);
  const p = path.join(tmpDir, `case${n}-${kind}.json`);
  fs.writeFileSync(p, JSON.stringify(d, null, 1), 'utf8');
  return runAudit(p);
};

try {
  for (const c of CASES) {
    n++;
    const bv = baseV[c.rule];
    if (bv === undefined) { fail.push(`${c.rule}: 基线里没有这条判据 —— 用例表与 RULES 已经脱节`); continue; }
    // 空洞守卫：基线结论与期望结论相同 ⇒ 这条断言恒成立，什么也没证明。
    // 本仓库为「0/0 被读成 100%」付过代价，这里是同一形状的变体。
    if (bv === c.want) {
      fail.push(`${c.rule}: 基线结论已经是 ${bv}，want 也是 ${bv} —— 这条变异断言恒真，等于没测`);
      continue;
    }

    // A. 定向变异：目标必须翻到 want
    const rA = applyCase(c, 'mutate');
    if (rA.spawnError) { fail.push(`${c.rule}: 变异后审计跑不起来 —— ${rA.spawnError}`); continue; }
    const vA = verdicts(rA);
    const got = vA[c.rule];
    const collateral = Object.keys(baseV).filter((k) => k !== c.rule && baseV[k] !== vA[k]);
    const okA = got === c.want;

    // B. 阴性对照：目标必须保持基线结论
    const rB = applyCase(c, 'control');
    if (rB.spawnError) { fail.push(`${c.rule}: 对照后审计跑不起来 —— ${rB.spawnError}`); continue; }
    const gotCtl = verdicts(rB)[c.rule];
    const okB = gotCtl === bv;

    results.push({ rule: c.rule, base: bv, want: c.want, got, ctl: gotCtl, collateral, okA, okB, why: c.why });
    if (!okA) fail.push(`${c.rule}: 定向变异后期望 ${c.want} 实际 ${got}（${c.why}）`);
    if (!okB) fail.push(`${c.rule}: 阴性对照后结论从 ${bv} 漂到 ${gotCtl} —— 判据会被无关改动触发`);
  }

  // ── 缺输入必须退 2，不许装成通过 ──
  n++;
  {
    const d = JSON.parse(fs.readFileSync(DESIGN, 'utf8'));
    const c0 = d.components.find((x) => x.des === 'R1');
    if (!c0) fail.push('未知料号: 设计里找不到 R1，用例失效');
    else {
      c0.lcsc = 'C99999999';   // 尺寸表里没有 → 该器件几何未知
      const p = path.join(tmpDir, 'case-unknown.json');
      fs.writeFileSync(p, JSON.stringify(d, null, 1), 'utf8');
      const r = runAudit(p);
      if (r.spawnError) fail.push(`未知料号: 审计跑不起来 —— ${r.spawnError}`);
      else if (r.summary.unsizedComps < 1) fail.push(`未知料号: 期望 ≥1 个器件尺寸未知，实际 ${r.summary.unsizedComps} —— 缺尺寸被静默忽略了`);
      else if (r.exitCode !== 2) fail.push(`未知料号: 期望 exit 2（无法判定），实际 ${r.exitCode} —— 缺输入被当成了通过`);
      else if (!/NOSAMPLE/.test(r.banner || '')) fail.push(`未知料号: exit 2 但 banner 是「${r.banner}」—— 退出码与结论文案对不上`);
      else note(`未知料号 → unsizedComps=${r.summary.unsizedComps} / exit 2 / ${r.banner.split('  ')[0]}`);
    }
  }
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 临时目录，清不掉不影响判定 */ }
}

// ── 汇总 ────────────────────────────────────────────────────────────
note('');
note(`  ${'判据'.padEnd(22)} ${'基线'.padEnd(6)} ${'变异→'.padEnd(12)} ${'对照→'.padEnd(8)} ${'附带'.padEnd(10)} 结论`);
note('  ' + '─'.repeat(104));
for (const r of results) {
  const col = r.collateral.length ? r.collateral.join(',') : '无';
  const mark = r.okA && r.okB ? '✓' : '✗';
  note(`  ${r.rule.padEnd(22)} ${r.base.padEnd(6)} ${(r.want + ' / ' + r.got).padEnd(12)} ${String(r.ctl).padEnd(8)} ${col.slice(0, 10).padEnd(10)} ${mark}`);
}
note('  ' + '─'.repeat(104));
const nSens = results.filter((r) => r.okA).length;
const nSpec = results.filter((r) => r.okB).length;
note(`  灵敏度（变异必翻）${nSens}/${results.length}　特异性（对照不动）${nSpec}/${results.length}`);

if (fail.length) {
  note('');
  for (const f of fail) note('  ✗ ' + f);
  console.error(`\nPLACEMENT-RULES=FAIL  ${fail.length}/${n} 项不通过 —— 摆放判据没有被证明会失败或会变绿`);
  process.exit(1);
}
console.log(`\nPLACEMENT-RULES=PASS  ${n}/${n} 项全过（${CASES.length} 条定向变异各自必翻 · ${CASES.length} 条阴性对照必不动 · 1 条未知料号必须退 2）`);
process.exit(0);
