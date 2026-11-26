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
  // ── 下面四条对应 2026-11-26 修掉的四个真缺陷。每条都先用旧版复现过：
  //    旧版这四个样本全部 exit 0 / 打通过，修完才变红（PROVE=PASS 14/14）。
  {
    rule: 'antenna_band_empty', want: 'fail',
    why: '【倒置盒】净空带 y 上下写反（y0=-3690, y1=-3700）。overlap() 对退化盒恒返回 0，'
       + '于是「侵入 0 个」被读成「净空干净」—— 一个倒置的盒子能静默通过。',
    mutate: (d) => { d._antennaKeepout.y0 = -3690; d._antennaKeepout.y1 = -3700; },
    control: (d) => { d._antennaKeepout.y1 = -3691; },  // 合法的窄带，仍为空
  },
  {
    rule: 'band_covers_antenna', want: 'fail',
    why: '【x 方向覆盖不足】带子只罩 748 mil 中的 100 mil。原实现只比 y 两端，x 完全不查。',
    mutate: (d) => { d._antennaKeepout.x1 = 376; },
    control: (d) => { d._antennaKeepout.x1 = 1025; },   // 多罩 1 mil
  },
  {
    rule: 'all_inside_board', want: 'fail',
    why: '【焊盘区越板】U1.y=-3500 ⇒ 焊盘区底 -3874，比板边低 174 mil。原实现用 '
       + 'Math.max(b.y0,-H) 把下界夹进板内，把「天线段悬出」（允许）与「焊盘出板」'
       + '（不可焊）合并成同一件事，于是焊盘越界被一起放过。',
    mutate: (d) => { d._placement.U1.y = -3500; },
    control: (d) => { d._placement.U1.y = -3320; },     // 焊盘区底 -3694，仍在板内
  },
  {
    rule: 'antenna_overhang', want: 'fail',
    why: '【旋转 90 的天线】U1 rot=90（天线朝 −X）放在 x=700 ⇒ 尖端 44，落在板内没悬出。'
       + '原实现只给 rot 0/180 算 antTip，旋转 90/270 时恒为 null ⇒ 这条判据对它们'
       + '判「无法判定」而静默退出，从没量过「天线朝左右」这种合法布局。',
    mutate: (d) => { d._placement.U1.x = 700; d._placement.U1.rot = 90; },
    control: (d) => { d._placement.U1.x = 600; d._placement.U1.rot = 90; }, // 尖端 -56，悬出 56
  },
];

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'place-rules-'));
const results = [];
let n = 0;
// CASES 表之外还有几个「独立证明块」（基线不是 v3 的那些）。它们必须逐个登记，
// 否则汇总行只会报 CASES.length，读者会以为新加的块不存在 —— 那是一次静默漏报。
// 结尾有一条 n === CASES.length + blocks.length 的不变式钉住它。
const blocks = [];

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
  // 这条用例的基线必须用 **v5**（11 条判据 11 通过、hardFail=0），不能用 CASES 的 v3。
  // 原先它用 v3 且一直通过，但那只是因为 v3 当时恰好没有 [PCB] 类失败 ——
  // 一旦 v3 上出现任何 [PCB] 类 failure，`hardFail>0` 就会把退出码定成 1，
  // 这条断言就变成在测「v3 有没有 PCB 缺陷」，而不是在测「缺输入会不会退 2」。
  // 变量没有被隔离的断言，passed 和 failed 都读不出结论。
  n++;
  blocks.push('未知料号：缺 R1 尺寸 ⇒ 必须退 2（不许装成通过）');
  {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'designs', 'mic-esp32s3-v5.json'), 'utf8'));
    const c0 = d.components.find((x) => x.des === 'R1');
    if (!c0) fail.push('未知料号: v5 里找不到 R1，用例失效');
    else {
      c0.lcsc = 'C99999999';   // 尺寸表里没有 → 该器件几何未知
      const p = path.join(tmpDir, 'case-unknown.json');
      fs.writeFileSync(p, JSON.stringify(d, null, 1), 'utf8');
      const r = runAudit(p);
      if (r.spawnError) fail.push(`未知料号: 审计跑不起来 —— ${r.spawnError}`);
      else if (r.summary.unsizedComps < 1) fail.push(`未知料号: 期望 ≥1 个器件尺寸未知，实际 ${r.summary.unsizedComps} —— 缺尺寸被静默忽略了`);
      else if (r.summary.failPcb > 0) fail.push(`未知料号: v5 基线本应 0 条 [PCB] 类失败，实际 ${r.summary.failPcb} —— 这条用例的前提已失效`);
      else if (r.exitCode !== 2) fail.push(`未知料号: 期望 exit 2（无法判定），实际 ${r.exitCode} —— 缺输入被当成了通过`);
      else if (!/NOSAMPLE/.test(r.banner || '')) fail.push(`未知料号: exit 2 但 banner 是「${r.banner}」—— 退出码与结论文案对不上`);
      else note(`未知料号 → unsizedComps=${r.summary.unsizedComps} / exit 2 / ${r.banner.split('  ')[0]}`);
    }
  }
  // ── decoupling_near_ic：修前样本必须判红、修后样本必须判绿 ──────────
  // 这一段独立于上面的 CASES 表。CASES 的基线是 v3，而这条判据的两个关键样本是
  // **v4（修前）与 v5（修后）** —— 拿 v3 当基线在两个方向上都可能恒真，证明不了任何事。
  // 断言分两层：① v4 判红，且红的**原因**必须真是 U4 没旁路（判红的原因是判据的语义，
  // 不是副产物）；② v5 判绿；③ 把 v5 里 U4 的专属电容挪走，必须重新变红；
  // ④ 只轻推 3 mil 的阴性对照必须维持绿，且不允许触发别的判据。
  n++;
  blocks.push('decoupling_near_ic：修前 v4 必红 → 修后 v5 必绿 → 挪走专属电容必再红 → 轻推 3 mil 必须不动');
  {
    const V4 = path.join(ROOT, 'designs', 'mic-esp32s3-v4.json');
    const V5 = path.join(ROOT, 'designs', 'mic-esp32s3-v5.json');
    const RID = 'decoupling_near_ic';
    const r4 = fs.existsSync(V4) ? runAudit(V4) : { spawnError: `缺样本 ${path.basename(V4)}` };
    const r5 = fs.existsSync(V5) ? runAudit(V5) : { spawnError: `缺样本 ${path.basename(V5)}` };

    if (r4.spawnError) fail.push(`decoupling[修前 v4]: ${r4.spawnError}`);
    else {
      const v4v = verdicts(r4)[RID];
      const d4 = (r4.rules || []).find((x) => x.id === RID) || {};
      if (v4v !== 'fail') {
        fail.push(`decoupling[修前 v4]: 期望 fail，实际 ${v4v} —— 这条判据抓不到`
          + '「3V3 上 5 个 IC 只有 4 个电容、U4（MEMS 麦）最近的 3V3 电容在 1404 mil 外」这个真缺陷');
      } else if (!/U4/.test(d4.detail || '')) {
        fail.push(`decoupling[修前 v4]: 判红了，但原因里没有 U4 —— 它红的不是我们要它抓的那件事：${String(d4.detail).slice(0, 160)}`);
      } else {
        note(`decoupling 修前 v4 → fail：${String(d4.detail).slice(0, 130)}`);
      }
    }

    if (r5.spawnError) fail.push(`decoupling[修后 v5]: ${r5.spawnError}`);
    else if (verdicts(r5)[RID] !== 'pass') {
      fail.push(`decoupling[修后 v5]: 期望 pass，实际 ${verdicts(r5)[RID]} —— 加两个 100nF 没把它修好`);
    } else {
      const d5v = (r5.rules || []).find((x) => x.id === RID) || {};
      // 分母必须写清且非空：只报「通过」而说不出判了几条电源轨，就是没有分母的结论。
      if (!/分母=1 条电源轨\[3V3\(/.test(d5v.detail || '')) {
        fail.push(`decoupling[修后 v5]: 通过了，但分母没写在输出里 —— ${String(d5v.detail).slice(0, 160)}`);
      } else note('decoupling 修后 v5 → pass，分母=1 条电源轨(3V3)');

      // ③ 定向变异：把 U4 的专属电容 C9 挪到板子右上（离 U4 420 mil）
      const d5 = JSON.parse(fs.readFileSync(V5, 'utf8'));
      const mv = JSON.parse(JSON.stringify(d5));
      mv._placement.C9 = { x: 1200, y: -340, rot: 0 };
      const pm = path.join(tmpDir, `dec-mutate-${n}.json`);
      fs.writeFileSync(pm, JSON.stringify(mv, null, 1), 'utf8');
      const rm = runAudit(pm);
      if (rm.spawnError) fail.push(`decoupling[变异]: ${rm.spawnError}`);
      else {
        const got = verdicts(rm)[RID];
        if (got !== 'fail') fail.push(`decoupling[变异]: 期望 fail，实际 ${got} —— 把 U4 的电容挪到 420 mil 外没触发判据`);
        const coll = Object.keys(verdicts(r5)).filter((k) => k !== RID && verdicts(r5)[k] !== verdicts(rm)[k]);
        if (coll.length) fail.push(`decoupling[变异]: 附带改变了 ${coll.join(',')} —— 判据之间串味`);
      }

      // ④ 阴性对照：C9 朝 U4 方向轻推 3 mil（间距 20 → 17 mil），必须维持 pass
      const ct = JSON.parse(JSON.stringify(d5));
      ct._placement.C9 = { x: 502, y: -312, rot: 0 };
      const pc = path.join(tmpDir, `dec-control-${n}.json`);
      fs.writeFileSync(pc, JSON.stringify(ct, null, 1), 'utf8');
      const rc = runAudit(pc);
      if (rc.spawnError) fail.push(`decoupling[对照]: ${rc.spawnError}`);
      else if (verdicts(rc)[RID] !== 'pass') {
        fail.push(`decoupling[对照]: 只挪 3 mil 就翻成 ${verdicts(rc)[RID]} —— 判据对无关微动敏感`);
      }
    }
  }
  // ── bypass_cap_distance：两颗「必须贴住」的旁路电容，逐个证明判据会红 ──
  // 这条判据是补上 decoupling_near_ic 的一个**结构性空洞**才出现的：后者把「单 IC 网」
  // 整桶排除（理由是 EN 的 RC 延时不在乎距离），而那一个排除同时放过了 IMU_CPOUT /
  // IMU_REGOUT 这类**必须在乎距离**的旁路。所以这里的证据必须分两个方向：
  //   ① v5 现状判绿，且分母与「未判名单」都写在输出里（否则分母就没了）；
  //   ② 把 C7 搬回它曾经待的地方（功放带 y=-2040）必须判红 —— 那个坐标是真实历史值；
  //   ③ 单独搬 C6 也必须判红 —— 两个电容各判各的，不许只靠一颗就下结论；
  //   ④ 阴性对照只推 5 mil，必须维持绿。
  n++;
  blocks.push('bypass_cap_distance：基线绿（分母=2 且未判名单必在）→ C7 搬回功放带必红 → 单独搬 C6 必红 → 轻推 5 mil 必须不动');
  {
    const V5 = path.join(ROOT, 'designs', 'mic-esp32s3-v5.json');
    const RID = 'bypass_cap_distance';
    const r5 = fs.existsSync(V5) ? runAudit(V5) : { spawnError: `缺样本 ${path.basename(V5)}` };
    if (r5.spawnError) fail.push(`bypass[基线]: ${r5.spawnError}`);
    else {
      const v5v = verdicts(r5)[RID];
      const d5 = (r5.rules || []).find((x) => x.id === RID) || {};
      if (v5v !== 'pass') {
        fail.push(`bypass[基线]: 期望 pass，实际 ${v5v} —— C6/C7 已经贴回 U5，判据却还在红：${String(d5.detail).slice(0, 160)}`);
      } else if (!/分母=2 组/.test(d5.detail || '')) {
        fail.push(`bypass[基线]: 通过了，但分母没写清 —— ${String(d5.detail).slice(0, 160)}`);
      } else if (!/未判 2 个单 IC 带电容网/.test(d5.detail || '')) {
        // 不属于任何角色的网必须**逐条列出未判**；不列出来就等于静默算作通过。
        fail.push(`bypass[基线]: 没把「不属于任何距离敏感角色」的网列出来 —— ${String(d5.detail).slice(0, 160)}`);
      } else note('bypass 基线 v5 → pass，分母=2 组（REGOUT/CPOUT）');

      const d5raw = JSON.parse(fs.readFileSync(V5, 'utf8'));
      // ② C7 搬回功放带原位（历史真实值 1080,-2040，实测距 U5 332 mil）
      const mv7 = JSON.parse(JSON.stringify(d5raw));
      mv7._placement.C7 = { x: 1080, y: -2040 };
      const p7 = path.join(tmpDir, `bypass-mut7-${n}.json`);
      fs.writeFileSync(p7, JSON.stringify(mv7, null, 1), 'utf8');
      const r7 = runAudit(p7);
      if (r7.spawnError) fail.push(`bypass[C7 搬回功放带]: ${r7.spawnError}`);
      else {
        const got = verdicts(r7)[RID];
        const dd = (r7.rules || []).find((x) => x.id === RID) || {};
        if (got !== 'fail') fail.push(`bypass[C7 搬回功放带]: 期望 fail，实际 ${got} —— 把 CPOUT 电容挪到 332 mil 外判据没反应`);
        else if (!/IMU_CPOUT/.test(dd.detail || '')) {
          fail.push(`bypass[C7 搬回功放带]: 判红了，但红的不是 CPOUT 那条 —— ${String(dd.detail).slice(0, 160)}`);
        }
        const coll = Object.keys(verdicts(r5)).filter((k) => k !== RID && verdicts(r5)[k] !== verdicts(r7)[k]);
        if (coll.length) fail.push(`bypass[C7 搬回功放带]: 附带改变了 ${coll.join(',')} —— 判据之间串味`);
      }
      // ③ 只搬 C6（IMU_REGOUT），C7 保持原位
      const mv6 = JSON.parse(JSON.stringify(d5raw));
      mv6._placement.C6 = { x: 890, y: -2040 };
      const p6 = path.join(tmpDir, `bypass-mut6-${n}.json`);
      fs.writeFileSync(p6, JSON.stringify(mv6, null, 1), 'utf8');
      const r6 = runAudit(p6);
      if (r6.spawnError) fail.push(`bypass[C6 搬回功放带]: ${r6.spawnError}`);
      else {
        const got = verdicts(r6)[RID];
        const dd = (r6.rules || []).find((x) => x.id === RID) || {};
        if (got !== 'fail') fail.push(`bypass[C6 搬回功放带]: 期望 fail，实际 ${got} —— 把 REGOUT 电容挪远判据没反应`);
        else if (!/IMU_REGOUT/.test(dd.detail || '')) {
          fail.push(`bypass[C6 搬回功放带]: 判红了，但红的不是 REGOUT 那条 —— ${String(dd.detail).slice(0, 160)}`);
        }
        // 分母仍须是 2（两颗都在判）。判红时若分母塌成 1，说明它只判了被改坏的那颗。
        else if (!/分母=2 组/.test(dd.detail || '')) {
          fail.push(`bypass[C6 搬回功放带]: 判红时分母不是 2 —— ${String(dd.detail).slice(0, 160)}`);
        }
      }
      // ④ 阴性对照：C7 朝远离 U5 的方向轻推 5 mil（76 → 81 mil），必须维持 pass
      const ct = JSON.parse(JSON.stringify(d5raw));
      ct._placement.C7 = { x: 425, y: -1720 };
      const pc = path.join(tmpDir, `bypass-control-${n}.json`);
      fs.writeFileSync(pc, JSON.stringify(ct, null, 1), 'utf8');
      const rc = runAudit(pc);
      if (rc.spawnError) fail.push(`bypass[对照]: ${rc.spawnError}`);
      else if (verdicts(rc)[RID] !== 'pass') {
        fail.push(`bypass[对照]: 只挪 5 mil 就翻成 ${verdicts(rc)[RID]} —— 判据对无关微动敏感`);
      }

      // ⑤ 边界正控：把 C7 放到**恰好等于**阈值的位置，必须放行；再远 1 mil 必须拦。
      // 这一对是唯一能区分 `>` 与 `>=` 的证据 —— 没有它，把判据写成 `>=` 全绿通过。
      // 算术：U5（C2912107 实测 189×205）在 x=650 ⇒ 左沿 555.5；C7（C3850164 实测 119×66）
      // 中心在 x、右沿 x+59.5 ⇒ 间隙 = 555.5-(x+59.5) = 496-x。x=396 ⇒ 恰好 100 mil。
      for (const [x, want, tag] of [[396, 'pass', '恰好 100 mil'], [395, 'fail', '101 mil']]) {
        const be = JSON.parse(JSON.stringify(d5raw));
        be._placement.C7 = { x, y: -1720 };
        const pb = path.join(tmpDir, `bypass-edge-${x}-${n}.json`);
        fs.writeFileSync(pb, JSON.stringify(be, null, 1), 'utf8');
        const rb = runAudit(pb);
        if (rb.spawnError) fail.push(`bypass[边界 ${tag}]: ${rb.spawnError}`);
        else if (verdicts(rb)[RID] !== want) {
          fail.push(`bypass[边界 ${tag}]: 期望 ${want}，实际 ${verdicts(rb)[RID]} —— 阈值写法很可能写成了相反的包含关系`);
        }
      }
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
// 分母自洽：每一项要么来自 CASES 表，要么在 blocks 里登记过。
// 不相等说明有人加了证明块却忘了登记 —— 那种情况下 PASS 行会少报工作量。
if (n !== CASES.length + blocks.length) {
  console.error(`\nPLACEMENT-RULES=FAIL  计数不自洽：n=${n}，但 CASES=${CASES.length} + blocks=${blocks.length}`
    + ' —— 有证明块没登记，汇总行会少报');
  process.exit(1);
}
console.log(`\nPLACEMENT-RULES=PASS  ${n}/${n} 项全过 ——`);
console.log(`  CASES 表 ${CASES.length} 条：定向变异各自必翻 ${nSens}/${CASES.length} · 阴性对照必不动 ${nSpec}/${CASES.length}`);
for (const b of blocks) console.log(`  独立证明块：${b}`);
process.exit(0);
