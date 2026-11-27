#!/usr/bin/env node
// 摆放合规审计：把「元器件怎么摆」从审美问题变成可判定的量。
//
// 用法：
//   node scripts/audit-placement.mjs <design.json> [--sizes <measured.json>]
//
// 退出码：0 全部通过 / 1 有判据不通过 / 2 有判据无法判定（缺尺寸等）
//
// ── 为什么要有这个文件 ────────────────────────────────────────────────
// 用户的批评原话是「你只是选择了一块板子，然后在上面铺满元器件。你并没有
// 合规的去摆放这些元器件，比如说根据基板的形状来决定元器件怎么摆放，就是
// 你要综合考量各种影响来画板子」。
//
// 「综合考量」如果不能变成「哪条判据、阈多少、为什么是这个数」，就永远只能
// 靠人看着顺眼不顺眼。而这个仓库被同一个坑咬过好几次：闸门只验「非空」、
// 有 47/72 份只记录计数不记录原因、0/0 被读成 100%。所以这里每条判据都必须
// 带三样东西：**依据**、**实测值**、**能不能由 PCB 保证**。
//
// ── 最关键的一条设计约束：区分「PCB 能保证」与「只能靠结构协同」 ─────────
// 这个仓库已经踩过一次：Espressif 要求天线两侧各 15mm 净空，而本板宽只有
// 33mm —— 这个要求**在这块板上无法表达**，只能由非金属壳体保证。
// 那次教训的结论是「几何上无法满足的判据不是判据」。
//
// 所以本文件的判据分两类：
//   [PCB]   —— 由铜箔/器件位置的几何决定，PCB 摆对了就成立。不通过 = 真缺陷。
//   [机构]  —— 声学隔离、手指可达、传感器标定这类，PCB 只能降低风险，
//              最终要靠结构件。不通过 = **警告**，不是判决。把它报成 FAIL
//              会让一块其实没救的板子和一块改个壳体就行的板子长得一样。
//
// 两类都在报告里，但只有 [PCB] 类能让退出码变 1。
'use strict';

import fs from 'node:fs';
import path from 'node:path';

// ── 元件实测尺寸（mil，自然朝向 rot=0，宽×高）──────────────────────────
// 来源：`scripts/_probe-sizes.js` 在 2026-11-26 于本板上实测
// （`eda.pcb_Primitive.getPrimitivesBBox([id])` 逐器件读包围盒）。
// **不是按封装名猜的**：0603 电阻与 0603 电容实测就不一样（115×58 vs 119×66），
// 0805 电阻和 0805 电容同理。按包名套表会得到系统性偏差。
// 换料后必须重跑探针更新这里；表里没有的料号一律判「无法判定」并退 2，
// 绝不退回按包名估的数 —— 那会静默改变判据。
const SIZES = {
  C2913199: { w: 748, h: 1030, note: 'ESP32-S3-WROOM-1（含天线段）' },
  C165948:  { w: 388, h: 329,  note: 'Type-C 16P' },
  C25905:   { w: 80,  h: 45,   note: '电阻 0402' },
  C6186:    { w: 362, h: 268,  note: 'AMS1117 SOT-223' },
  C440198:  { w: 161, h: 77,   note: '电容 0805' },
  C14663:   { w: 119, h: 66,   note: '电容 0603' },
  C3850164: { w: 119, h: 66,   note: '电容 0603 (2.2nF C0G)' },
  C2912107: { w: 189, h: 205,  note: 'MPU-6050 QFN-24' },
  C910544:  { w: 142, h: 151,  note: 'MAX98357A TQFN-16' },
  C49023793:{ w: 305, h: 284,  note: '排针 2P P=2.54' },
  C2832146: { w: 217, h: 128,  note: '轻触开关 3×4mm' },
  C11702:   { w: 80,  h: 45,   note: '电阻 0402 1k' },
  C25804:   { w: 115, h: 58,   note: '电阻 0603 10k' },
  C2297:    { w: 176, h: 91,   note: 'LED 0805' },
  C2875567: { w: 143, h: 167,  note: 'MEMS 麦克风' },
};

// ESP32-S3-WROOM-1 的内部结构（实测，见 docs/FAILURES.md 与 _v3Reason）：
// 包围盒 748×1030 = 焊盘区 748×748 圆心 + 天线段 282 向一端延伸。
// 封装原点 = 焊盘区中心，所以天线伸出方向随 rot 变：
//   rot 0 → +Y，rot 180 → −Y，rot 90 → −X，rot 270 → +X
const ANT_LEN = 282;
const PAD_HALF = 374;
const ANT_ROT_DIR = { 0: [0, 1], 180: [0, -1], 90: [-1, 0], 270: [1, 0] };

function geom(des, p, lcsc) {
  const s = SIZES[lcsc];
  if (!s) return null;
  const rot = ((Math.round(Number(p.rot) || 0) % 360) + 360) % 360;
  // U1 的天线段让包围盒不再对称，必须按 rot 定向展开，不能简单换宽高。
  if (lcsc === 'C2913199') {
    const d = ANT_ROT_DIR[rot];
    if (!d) return null;
    // 沿天线方向的半跨度是 PAD_HALF+ANT_LEN，反向（焊盘侧）是 PAD_HALF
    const ex = d[0] !== 0 ? (PAD_HALF + ANT_LEN) : PAD_HALF;
    const ey = d[1] !== 0 ? (PAD_HALF + ANT_LEN) : PAD_HALF;
    // 天线可以朝 4 个方向悬出。原先只给 rot 0/180 算 antTip，旋转 90/270 时
    // 恒为 null ⇒ `antenna_overhang` 判「无法判定」而**静默退出**，
    // 也就是「天线朝左/右」这个合法布局在审计里从没被量过。必须四向都算。
    // 悬出量一律相对**它朝的那条板边**，不能让调用方各自猜。
    const antAxis = d[0] !== 0 ? 'x' : 'y';
    const antDir = d[0] !== 0 ? (d[0] < 0 ? -1 : 1) : (d[1] < 0 ? -1 : 1);
    const antTip = antAxis === 'y'
      ? p.y + antDir * (PAD_HALF + ANT_LEN)
      : p.x + antDir * (PAD_HALF + ANT_LEN);
    // 焊盘区是按 origin 对称的 PAD_HALF 方框，与朝向无关。放行「天线段悬出」
    // 时只能放行这一圈之外的部分，焊盘区本身绝不许出板。
    return {
      des, lcsc, x: p.x, y: p.y, rot, w: s.w, h: s.h,
      x0: p.x - (d[0] < 0 ? ex : PAD_HALF),
      x1: p.x + (d[0] > 0 ? ex : PAD_HALF),
      y0: p.y - (d[1] < 0 ? ey : PAD_HALF),
      y1: p.y + (d[1] > 0 ? ey : PAD_HALF),
      padX0: p.x - PAD_HALF, padX1: p.x + PAD_HALF,
      padY0: p.y - PAD_HALF, padY1: p.y + PAD_HALF,
      padBottom: p.y - PAD_HALF,
      antAxis, antDir, antTip,
    };
  }
  const swap = rot % 180 === 90;
  const w = swap ? s.h : s.w;
  const h = swap ? s.w : s.h;
  return {
    des, lcsc, x: p.x, y: p.y, rot, w, h,
    x0: p.x - w / 2, x1: p.x + w / 2,
    y0: p.y - h / 2, y1: p.y + h / 2,
  };
}

const overlap = (a, b, shrink) => {
  const x0 = Math.max(a.x0, b.x0) + shrink, x1 = Math.min(a.x1, b.x1) - shrink;
  const y0 = Math.max(a.y0, b.y0) + shrink, y1 = Math.min(a.y1, b.y1) - shrink;
  return x1 > x0 && y1 > y0 ? (x1 - x0) * (y1 - y0) : 0;
};
const inside = (b, x0, y0, x1, y1) =>
  b.x0 >= x0 - 0.5 && b.x1 <= x1 + 0.5 && b.y0 >= y0 - 0.5 && b.y1 <= y1 + 0.5;
const mm = (mil) => mil / 39.3701;

// ── 判据表 ────────────────────────────────────────────────────────────
// 每条：id / kind([PCB] 或 [机构]) / basis（为什么是这个判据）/ fn
const RULES = [
  {
    id: 'antenna_band_empty',
    kind: 'PCB',
    basis: 'Espressif《ESP32-S3-WROOM-1 硬件设计指南》：天线区域严禁铺铜、走线、摆放元件。'
         + '天线正上/正下方有铜或器件会直接改变谐振点、拉偏增益。',
    fn: (d, g) => {
      const K = d._antennaKeepout;
      if (!K) return { ok: false, why: '设计文件没有 _antennaKeepout —— 无法判定天线净空' };
      // 先把盒子本身验一遍。`overlap()` 对退化盒（x1<=x0 或 y1<=y0）恒返回 0，
      // 于是「侵入 0 个」会被读成「净空干净」—— 一个倒置的盒子能静默通过。
      // 实测过：`y0=-3690, y1=-3700`（上下写反）→ 本判据打 pass、exitCode=0。
      // 这不是保守不保守的问题，是**分母为空却给出「全清」结论**。
      const boxBad = [];
      for (const k of ['x0', 'x1', 'y0', 'y1']) {
        if (!Number.isFinite(K[k])) boxBad.push(`${k}=${JSON.stringify(K[k])} 不是有限数`);
      }
      if (!(K.x1 > K.x0)) boxBad.push(`x 方向倒置或退化：x0=${K.x0} ≥ x1=${K.x1}`);
      if (!(K.y1 > K.y0)) boxBad.push(`y 方向倒置或退化：y0=${K.y0} ≥ y1=${K.y1}`);
      if (boxBad.length) {
        return { ok: false, why: '净空带盒子无效，任何「侵入 0 个」的结论都不可信：' + boxBad.join('；') };
      }
      const allow = new Set(K.allowDesignators || []);
      const band = { x0: K.x0, x1: K.x1, y0: K.y0, y1: K.y1, des: 'band' };
      const hits = [];
      for (const b of g.comps) {
        if (allow.has(b.des)) continue;
        const a = overlap(b, band, 0);
        if (a > 0) hits.push(`${b.des} 侵入 ${Math.round(a)} mil²`);
      }
      return hits.length
        ? { ok: false, why: hits.join(' / '), value: `带子 [${K.y0},${K.y1}]` }
        : { ok: true, value: `带子 [${K.y0},${K.y1}] 内只有 ${[...allow].join(',') || '空'}` };
    },
  },
  {
    id: 'antenna_overhang',
    kind: 'PCB',
    basis: 'Espressif 强烈推荐天线伸出板边（否则要挖掉天线两侧与下方的基板）。'
         + '天线贴在介质上会因介电常数偏移而失谐；悬出量越大越接近自由空间。',
    fn: (d, g) => {
      const u1 = g.comps.find((c) => c.des === 'U1');
      if (!u1 || u1.antTip == null) return { why: '找不到 U1 或天线朝向无法判定' };
      // 悬出量必须相对**天线朝向的那条板边**：朝 −Y 比下边(−H)，朝 +Y 比上边(0)，
      // 朝 −X 比左边(0)，朝 +X 比右边(W)。原先只写了下边，旋转 90/270 时
      // antTip 恒为 null，这条判据对它们从未执行过。
      // 分母要写清：这里比的是**设计标称板边**。流水线比的是**实测板框**
      // （`overhangDetail.boardMinY`，本板实测 −3705，比标称低 5 mil）。
      // 两个分母都成立、数值差 5~11 mil —— 所以结论必须带上是哪一个。
      const edge = u1.antAxis === 'y'
        ? (u1.antDir < 0 ? -d.boardHeightMil : 0)
        : (u1.antDir < 0 ? 0 : d.boardWidthMil);
      const raw = u1.antDir < 0 ? edge - u1.antTip : u1.antTip - edge;
      const note = `（分母=设计标称板边 ${u1.antAxis}=${edge}；实测板框见流水线 overhangDetail）`;
      return raw > 0
        ? { ok: true, value: `悬出 ${Math.round(raw)} mil (${mm(raw).toFixed(2)} mm)，天线尖端 ${Math.round(u1.antTip)} / 板边 ${edge} ${note}` }
        : { ok: false, why: `天线未悬出：尖端 ${Math.round(u1.antTip)} vs 板边 ${edge}（差 ${Math.round(raw)}）${note}` };
    },
  },
  {
    id: 'band_covers_antenna',
    kind: 'PCB',
    basis: '悬出之后，天线**压在板上的那一段**（板边 → 天线内缘）仍必须全层无铜。'
         + '本仓库真踩过：带子只写到 −3692 而天线内缘在 −3690，留了 2 mil 裸露缝，'
         + '铺铜可以伸进去。判据用「带子上界 ≥ 焊盘区底」表达，不写死数字 —— '
         + 'placement 一动，正确答案跟着动。',
    fn: (d, g) => {
      const K = d._antennaKeepout;
      const u1 = g.comps.find((c) => c.des === 'U1');
      if (!K || !u1) return { why: '缺 _antennaKeepout 或 U1' };
      const bad = [];
      // ① 盒子必须有效。倒置/退化的盒子会让「gap 为负 / cover 为负」双双成立，
      //    于是这条判据在**什么都没罩住**的时候打通过。
      for (const k of ['x0', 'x1', 'y0', 'y1']) {
        if (!Number.isFinite(K[k])) bad.push(`${k}=${JSON.stringify(K[k])} 不是有限数`);
      }
      if (!(K.x1 > K.x0)) bad.push(`x 方向倒置或退化：x0=${K.x0} ≥ x1=${K.x1}`);
      if (!(K.y1 > K.y0)) bad.push(`y 方向倒置或退化：y0=${K.y0} ≥ y1=${K.y1}`);
      if (bad.length) return { ok: false, why: '净空带盒子无效，覆盖结论不可信：' + bad.join('；') };
      // ② 按天线朝向取口径。沿天线轴：带子要从**板边**一路盖到**天线内缘**；
      //    垂直天线轴：带子要罩住天线焊盘区的整个宽度。
      //    原实现把口径写死成「板边 −H → 焊盘区底」，于是只对「天线朝 −Y」成立，
      //    天线朝上/左/右的板子会拿 −H 去比一个完全无关的面。
      //    注意：这里**不能**再单独写一条「x 覆盖」—— 垂直轴随朝向变，
      //    写死 x 会在天线朝左右时把合法带子判红（自己踩过）。
      const H = d.boardHeightMil, W = d.boardWidthMil;
      const along = u1.antAxis;
      const edge = along === 'y'
        ? (u1.antDir < 0 ? -H : 0)
        : (u1.antDir < 0 ? 0 : W);
      const inner = along === 'y'
        ? (u1.antDir < 0 ? u1.padY0 : u1.padY1)
        : (u1.antDir < 0 ? u1.padX0 : u1.padX1);
      // 带子沿天线轴的两个端点，统一成「靠近板边的一端」lo 与「靠近器件的一端」hi
      const kLo = along === 'y' ? (u1.antDir < 0 ? K.y0 : K.y1) : (u1.antDir < 0 ? K.x0 : K.x1);
      const kHi = along === 'y' ? (u1.antDir < 0 ? K.y1 : K.y0) : (u1.antDir < 0 ? K.x1 : K.x0);
      // 垂直轴的覆盖范围（带子 vs 焊盘区）
      const pLo = along === 'y' ? u1.padX0 : u1.padY0;
      const pHi = along === 'y' ? u1.padX1 : u1.padY1;
      const kPLo = along === 'y' ? K.x0 : K.y0;
      const kPHi = along === 'y' ? K.x1 : K.y1;
      if (kPLo > pLo + 0.5 || kPHi < pHi - 0.5) {
        bad.push(`垂直天线轴（${along === 'y' ? 'x' : 'y'}）覆盖不足：带子 [${kPLo},${kPHi}] 没罩住焊盘区 [${Math.round(pLo)},${Math.round(pHi)}]`);
      }
      // 板边一侧：带子必须伸到板边（kLo 要比 edge 更外）
      if (u1.antDir < 0 ? kLo > edge + 0.5 : kLo < edge - 0.5) {
        bad.push(`板边一侧未罩：带子端点 ${Math.round(kLo)} 没到板边 ${edge}（差 ${Math.round(Math.abs(kLo - edge))} mil）`);
      }
      // 器件一侧：带子要盖到天线内缘（kHi 要比 inner 更靠外）
      if (u1.antDir < 0 ? kHi < inner - 0.5 : kHi > inner + 0.5) {
        bad.push(`器件一侧未盖到天线内缘：带子端点 ${Math.round(kHi)} vs 天线内缘 ${Math.round(inner)}（差 ${Math.round(Math.abs(kHi - inner))} mil，会留裸露缝）`);
      }
      const span = Math.abs(inner - edge);
      // ④ 负跨度守卫：U1 焊盘区越过板边时 inner 跑到 edge 之外，
      //    上面两条「有没有盖到」会同时被满足。实测过：U1.y=−3500 ⇒
      //    焊盘区底 −3874，比板边低 174 mil，本判据却打通过。
      const outside = u1.antDir < 0 ? inner < edge : inner > edge;
      if (outside) {
        bad.push(`焊盘区已越板：天线内缘 ${Math.round(inner)} 在板边 ${edge} 之外（${Math.round(Math.abs(inner - edge))} mil）—— 这不是净空问题，先修摆放`);
      }
      return bad.length
        ? { ok: false, why: bad.join('；') }
        : { ok: true, value: `带子 [${K.y0},${K.y1}] × [${K.x0},${K.x1}] 沿 ${along} 覆盖 板边 ${edge} → 天线内缘 ${Math.round(inner)}（${Math.round(span)} mil）` };
    },
  },
  {
    id: 'all_inside_board',
    kind: 'PCB',
    basis: '器件焊盘在板外 = 该焊盘不可焊。本仓库真踩过：U1.y=-3467 把 122 mil 模组焊盘'
         + '放到板外，7 份布线引擎配置全部零走线。天线段按设计允许悬出，单独放行。',
    fn: (d, g) => {
      const bad = [];
      const H = d.boardHeightMil;
      const W = d.boardWidthMil;
      for (const b of g.comps) {
        // 天线段按设计允许悬出板边。但**只放行天线段**：原实现用
        // `Math.max(b.y0, -H)` 把整个包围盒的下界夹进板内，于是天线段之外的
        // 其余部分（尤其**焊盘区**）越界也会被一起放过。实测过：U1.y=−3500 时
        // 焊盘区底 −3874，有 174 mil 焊盘挂在板外，本判据仍打 pass。
        // 焊盘在板外 = 不可焊，这与「悬出」是完全不同的缺陷，不能合并处理。
        if (b.lcsc === 'C2913199' && b.padX0 != null) {
          const oob = [];
          if (b.padX0 < -0.5) oob.push(`左 ${Math.round(-b.padX0)}`);
          if (b.padX1 > W + 0.5) oob.push(`右 ${Math.round(b.padX1 - W)}`);
          if (b.padY0 < -H - 0.5) oob.push(`下 ${Math.round(-H - b.padY0)}`);
          if (b.padY1 > 0.5) oob.push(`上 ${Math.round(b.padY1)}`);
          if (oob.length) {
            bad.push(`${b.des} 焊盘区 [${Math.round(b.padX0)},${Math.round(b.padY0)},${Math.round(b.padX1)},${Math.round(b.padY1)}] 越界 ${oob.join('/')} mil（天线段悬出允许，焊盘区不许）`);
          }
          continue;
        }
        if (!inside(b, 0, -H, W, 0)) {
          bad.push(`${b.des} bbox [${Math.round(b.x0)},${Math.round(b.y0)},${Math.round(b.x1)},${Math.round(b.y1)}]`);
        }
      }
      return bad.length ? { ok: false, why: bad.join(' / ') } : { ok: true, value: `${g.comps.length} 个器件全部在板内（U1 仅天线段按设计悬出，焊盘区已逐一验证在板内）` };
    },
  },
  {
    id: 'no_bbox_overlap',
    kind: 'PCB',
    basis: '两个器件的实体包围盒相交在物理上不可能同时贴装。'
         + '用 2 mil 收缩容忍尺寸表的舍入，避免把「刚好相切」误判成重叠。',
    fn: (d, g) => {
      const bad = [];
      for (let i = 0; i < g.comps.length; i++) {
        for (let j = i + 1; j < g.comps.length; j++) {
          const a = overlap(g.comps[i], g.comps[j], 2);
          if (a > 0) bad.push(`${g.comps[i].des}×${g.comps[j].des} ${Math.round(a)} mil²`);
        }
      }
      return bad.length ? { ok: false, why: bad.join(' / ') } : { ok: true, value: `两两不重叠（${(g.comps.length * (g.comps.length - 1)) / 2} 对）` };
    },
  },
  {
    id: 'connector_at_edge',
    kind: 'PCB',
    basis: '插头要从板外伸进来，**对外插接件**的对口面必须在板边。'
         + '离边超过 100 mil（2.5 mm）时插头会被壳体/板体挡住，属于不可插。'
         + '只判对外插接件（USB）：2.54mm 排针是内部线头，线可以在壳体内自由走，'
         + '把它也要求贴边是无意义的判据 —— 第一版误判过，已在实测里发现。',
    fn: (d, g) => {
      const EDGE_REACH = 100;
      const b = g.comps.find((c) => c.des === 'USB1');
      if (!b) return { why: 'USB1 不在设计里 —— 无法判定对外插接件是否可插' };
      // 到四条板边的距离。第一版写成 `-H - b.y0`，对 y0<0 恒为负，
      // 于是**任何器件都通过**（负数必然 ≤ 阈值）。正确的下方距边是 b.y0 - (-H)。
      const dists = {
        左: b.x0, 右: d.boardWidthMil - b.x1,
        下: b.y0 - -d.boardHeightMil, 上: 0 - b.y1,
      };
      const [side, dist] = Object.entries(dists).sort((a, b2) => a[1] - b2[1])[0];
      const h1 = g.comps.find((c) => c.des === 'H1');
      const h1Note = h1
        ? `；H1 排针离边 ${Math.round(Math.min(h1.x0, d.boardWidthMil - h1.x1, h1.y0 + d.boardHeightMil, -h1.y1))} mil（内部线头，不判）`
        : '';
      return dist <= EDGE_REACH
        ? { ok: true, value: `USB1 对口面离${side}边 ${Math.round(dist)} mil ≤ ${EDGE_REACH}${h1Note}` }
        : { ok: false, why: `USB1 离最近板边（${side}）${Math.round(dist)} mil > ${EDGE_REACH} —— 插头进不来${h1Note}` };
    },
  },
  {
    id: 'usb_at_end',
    kind: '机构',
    basis: '人机工程：棒状手持设备的数据/充电口应在一端。装在长边中段时线缆从手心'
         + '侧向伸出，握持与放置都别扭，且插拔力直接作用在握持点上。'
         + 'PCB 只能把口挪到端部，最终是否好用还取决于壳体开口位置。',
    fn: (d, g) => {
      const b = g.comps.find((c) => c.des === 'USB1');
      if (!b) return { why: 'USB1 不在设计里' };
      // 【分母】「在端部」的分母必须是**可用**长度，不是整板长度。
      // 板底那一段是天线净空（Espressif 要求天线区无铜无器件），器件本来就不许进去，
      // 它不是"离端部太远的中间段"，它是**根本不存在的端点**。
      // 第一版拿整板 H 当分母，于是 USB1 在 -2900 被判「74% 处、中段」——
      // 而那是可用跨度 3690 的 98.5% 处，实际已经贴到能贴的最下端了。
      // 分母错了会给出一个看起来很专业、实际相反的判定（同 drcLeafCount vs
      // drcTotalCount 混用是一类错误）。
      const H = d.boardHeightMil;
      const k = d._antennaKeepout;
      let usableBottom = -H;
      let denomNote = `整板 ${H} mil`;
      if (k && Number.isFinite(k.y1) && k.y0 <= -H + 1) {
        // 净空带压住板底 ⇒ 可用下界抬到带子上沿
        usableBottom = k.y1;
        denomNote = `可用跨度 ${Math.round(-usableBottom)} mil（整板 ${H} 减去天线净空带顶部 ${Math.round(k.y1)}）`;
      }
      const span = -usableBottom;
      if (!(span > 0)) return { why: `可用跨度是 ${span}，无法判定` };
      const distTop = Math.abs(b.y - 0);
      const distBot = Math.abs(b.y - usableBottom);
      const dist = Math.min(distTop, distBot);
      const END = 0.25;
      const frac = dist / span;            // 0=贴端部
      const atEnd = frac <= END;
      return atEnd
        ? { ok: true, value: `USB1 离最近的可用端部 ${Math.round(dist)} mil = 可用跨度 ${Math.round(span)} 的 ${(frac * 100).toFixed(1)}%（阈值 ${END * 100}%）；分母 = ${denomNote}` }
        : { ok: false, why: `USB1 离最近的可用端部 ${Math.round(dist)} mil = 可用跨度 ${Math.round(span)} 的 ${(frac * 100).toFixed(1)}% > 阈值 ${END * 100}% —— 在长边中段；分母 = ${denomNote}` };
    },
  },
  {
    id: 'imu_near_centerline',
    kind: '机构',
    basis: '六轴 IMU 偏离握持旋转轴时，绕板长轴的转动会同时激励两个轴，'
         + '「往哪边歪」需要靠耦合矩阵解耦，标定成本与误差都上升。'
         + '判据取板宽 10% —— 这是工程目标而非行业硬标准，故意标得保守。',
    fn: (d, g) => {
      const b = g.comps.find((c) => c.des === 'U5');
      if (!b) return { why: 'U5 不在设计里' };
      const mid = d.boardWidthMil / 2;
      const off = Math.abs(b.x - mid);
      const tol = d.boardWidthMil * 0.1;
      return off <= tol
        ? { ok: true, value: `偏轴 ${Math.round(off)} mil (${mm(off).toFixed(2)} mm) ≤ 容差 ${Math.round(tol)}` }
        : { ok: false, why: `U5 偏轴 ${Math.round(off)} mil (${mm(off).toFixed(2)} mm) > 容差 ${Math.round(tol)} mil（中心线 x=${mid}）` };
    },
  },
  {
    id: 'mic_speaker_apart',
    kind: '机构',
    basis: '麦克风与扬声器同处一个腔体时存在声反馈（啸叫）。'
         + '但本设计的扬声器是**外接**的（H1 只是 2.54mm 排针），'
         + '声学路径由壳体与喇叭安装位置决定 —— **PCB 无法保证**这项。'
         + '所以只做警告，并把距离报出来供结构设计参考。'
         + '把它报成 FAIL 会让「改个壳体就能救」和「布局必须重做」看起来一样。',
    fn: (d, g) => {
      const m = g.comps.find((c) => c.des === 'U4');
      const s = g.comps.find((c) => c.des === 'H1');
      if (!m || !s) return { why: '找不到 U4(麦克风) 或 H1(扬声器口)' };
      const dist = Math.hypot(m.x - s.x, m.y - s.y);
      const MIN = 1969;    // 50 mm
      return dist >= MIN
        ? { ok: true, value: `麦克风↔扬声器口 ${Math.round(dist)} mil (${mm(dist).toFixed(1)} mm) ≥ ${mm(MIN).toFixed(0)} mm` }
        : { ok: false, why: `麦克风↔扬声器口仅 ${Math.round(dist)} mil (${mm(dist).toFixed(1)} mm) < ${mm(MIN).toFixed(0)} mm —— 同腔体易啸叫，需结构隔离` };
    },
  },
  {
    id: 'buttons_centered',
    kind: '机构',
    basis: '三个用户按键（PTT/BTN2/BTN3）应关于板中线对称，拇指才能不加区别地够到。'
         + '倾向某侧会让「按 PTT」变成一个需要低头找的动作。',
    fn: (d, g) => {
      const des = ['SW1', 'SW2', 'SW3'];
      const bs = des.map((x) => g.comps.find((c) => c.des === x));
      if (bs.some((b) => !b)) return { why: `缺按键：${des.filter((x, i) => !bs[i]).join(',')}` };
      const mid = d.boardWidthMil / 2;
      const xs = bs.map((b) => b.x);
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      const spread = Math.max(...xs) - Math.min(...xs);
      const off = Math.abs(mean - mid);
      const tol = d.boardWidthMil * 0.10;
      return off <= tol
        ? { ok: true, value: `三键均位 ${Math.round(mean)} vs 中线 ${mid}，跨距 ${Math.round(spread)} mil` }
        : { ok: false, why: `三键均位 ${Math.round(mean)} 偏离中线 ${mid} 达 ${Math.round(off)} mil > 容差 ${Math.round(tol)}` };
    },
  },
  {
    id: 'decoupling_near_ic',
    kind: 'PCB',
    basis: '每个 IC 的电源脚都要有自己的旁路电容，而且要贴着放 —— 去耦靠的是「小环路 + 短路径」，'
         + '电容离得远，中间那段走线本身就成了电感，100nF 在需要它的那个频点上已经不是短路了。'
         + '距离取**边缘到边缘**而不是中心距：贴着大封装放的时候中心距会被封装尺寸放大成假缺陷，'
         + '决定环路的是两段铜之间那段间隙。阈值按电容值分档：<1uF 取 250 mil，≥1uF 取 400 mil。'
         + '一个电容只服务一个 IC —— 同一个电容不能同时当两个 IC 的旁路。',
    fn: (d, g) => {
      const conns = Array.isArray(d.connections) ? d.connections : [];
      if (!conns.length) return { why: '设计文件没有 connections —— 无从判断哪个电容服务哪个 IC' };
      // 位号分类：IC = /^U\d+$/（USB1 是连接器，不算 IC），电容 = /^C\d+$/
      const isIC = (des) => /^U\d+$/.test(des);
      const isCap = (des) => /^C\d+$/.test(des);
      const byNet = new Map();
      for (const row of conns) {
        if (!Array.isArray(row) || row.length < 3) {
          return { why: `connections 里有形状不对的行，无法解读网表：${JSON.stringify(row)}` };
        }
        const [des, , net] = row;
        if (!byNet.has(net)) byNet.set(net, new Map());
        const m = byNet.get(net);
        if (!m.has(des)) m.set(des, []);
        m.get(des).push(row[1]);
      }
      // 返回网 = 引脚数最多的那个网。它在每条电容支路上都出现，
      // 拿它当电源轨判只会得到一条恒真的结论（而且会让所有 IC 都「配上了」）。
      let ret = null, retPins = -1;
      for (const [net, m] of byNet) {
        let n = 0;
        for (const ps of m.values()) n += ps.length;
        if (n > retPins) { retPins = n; ret = net; }
      }
      const box = new Map(g.comps.map((c) => [c.des, c]));
      const gap = (a, b) => {
        const dx = a.x1 < b.x0 ? b.x0 - a.x1 : (b.x1 < a.x0 ? a.x0 - b.x1 : 0);
        const dy = a.y1 < b.y0 ? b.y0 - a.y1 : (b.y1 < a.y0 ? a.y0 - b.y1 : 0);
        return Math.hypot(dx, dy);
      };
      const farad = (v) => {
        const m = String(v || '').match(/^\s*([\d.]+)\s*(p|n|u|µ)\s*f/i);
        if (!m) return null;
        return Number(m[1]) * ({ p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6 })[m[2].toLowerCase()];
      };
      const valOf = new Map((d.components || []).map((c) => [c.des, c.value]));
      const judged = [];
      const misses = [];
      const skipped = [];
      const excluded = { oneIc: [], noCap: [] };
      for (const [net, m] of byNet) {
        if (net === ret) continue;
        const ics = [...m.keys()].filter(isIC);
        const caps = [...m.keys()].filter(isCap);
        // 「配电轨」= 连到 ≥2 个 IC **且已经放了电容**的网。
        //   · 单 IC 的网（EN / IMU_REGOUT / IMU_CPOUT）不是配电轨 —— 它们各自的旁路
        //     要求完全不同（EN 是 RC 延时，放远 349mil 也无所谓），拿同一条阈值判会制造假缺陷。
        //   · 零电容的网与信号网在网表上**无法区分**（MIC_WS 也连 2 个 IC），
        //     所以本判据**跳过**它，而不是判它通过。这是本条判据的已知边界，写在输出里。
        if (ics.length < 2) { excluded.oneIc.push(`${net}(${ics.length})`); continue; }
        if (!caps.length) { excluded.noCap.push(net); continue; }
        judged.push(`${net}(${ics.length} 个 IC / ${caps.length} 个电容)`);
        const pairs = [];
        for (const ic of ics) {
          const bi = box.get(ic);
          if (!bi) { skipped.push(`${net}: ${ic} 尺寸未知`); continue; }
          for (const cp of caps) {
            const bc = box.get(cp);
            if (!bc) { skipped.push(`${net}: ${cp} 尺寸未知`); continue; }
            const f = farad(valOf.get(cp));
            pairs.push({ ic, cp, dd: gap(bi, bc), tol: f == null ? null : (f >= 1e-6 ? 400 : 250) });
          }
        }
        // 贪心分配：按距离从近到远，每个 IC 与每个电容各只能用一次。
        // 不追求最优匹配 —— 贪心的误差方向是更保守（可能把能配上的判成配不上），
        // 不会反过来放过真缺陷。方向比最优性重要。
        pairs.sort((a, b) => a.dd - b.dd);
        const icDone = new Set(), capUsed = new Set(), assign = [];
        for (const p of pairs) {
          if (p.tol == null) continue;
          if (icDone.has(p.ic) || capUsed.has(p.cp)) continue;
          icDone.add(p.ic); capUsed.add(p.cp); assign.push(p);
        }
        for (const a of assign) {
          if (a.dd > a.tol) {
            misses.push(`${net}: ${a.ic} 的最近专属电容 ${a.cp} 距 ${Math.round(a.dd)} mil > 阈值 ${a.tol} mil`);
          }
        }
        for (const ic of ics) {
          if (icDone.has(ic) || !box.get(ic)) continue;
          const near = pairs.filter((p) => p.ic === ic).sort((a, b) => a.dd - b.dd)[0];
          misses.push(near
            ? `${net}: ${ic} 没有专属旁路电容（最近的 ${near.cp} 已分配给别的 IC，距 ${ic} ${Math.round(near.dd)} mil）`
            : `${net}: ${ic} 一个电容都没有`);
        }
      }
      if (!judged.length) {
        return { why: `没有找到任何配电轨（连到 ≥2 个 IC 的网；已排除返回网 ${ret}）—— 这条判据在本设计上没有分母` };
      }
      const denom = `分母=${judged.length} 条电源轨[${judged.join('；')}]，返回网 ${ret} 已排除`
        + (excluded.oneIc.length ? `；跳过 ${excluded.oneIc.length} 个单 IC 网[${excluded.oneIc.join(',')}]` : '')
        + (excluded.noCap.length ? `；跳过 ${excluded.noCap.length} 个零电容网（与信号网在网表上无法区分，跳过而非判通过）[${excluded.noCap.join(',')}]` : '');
      if (skipped.length) return { why: `${[...new Set(skipped)].join(' / ')} —— 缺尺寸就不能判，不能当成通过（${denom}）` };
      return misses.length
        ? { ok: false, why: `${misses.join(' / ')}（${denom}）` }
        : { ok: true, value: `每条电源轨上的每个 IC 都配到了电容且不超阈值（${denom}）` };
    },
  },
  {
    id: 'bypass_cap_distance',
    kind: 'PCB',
    basis: '上一条判据只判「连到 ≥2 个 IC 的配电轨」，把单 IC 网整个排除了，理由是 EN 这类 RC 延时'
         + '网对距离不敏感。**那个排除一次性把两种网塞进了同一个桶**：确实不敏感的'
         + '（EN/BOOT 的 RC 延时、SPK_* 功率输出、CC1/CC2 连接器下拉），和**必须在乎距离的**'
         + '（IMU_CPOUT / IMU_REGOUT —— MPU-6050 电荷泵与内部稳压器的旁路，数据手册要求贴着引脚）。'
         + '实测代价：designs/mic-esp32s3-v5.json 里 C7 是 IMU_CPOUT 的 2.2nF，摆在离 U5'
         + ' **332 mil（8.43 mm）** 处，而 C4 就贴在 26 mil —— C7 被放进了功放带，'
         + 'relayout.mjs 那条带子的注释还把 CPOUT 写成功放的（MAX98357A 根本没有 CPOUT 引脚），'
         + '所以没人发现。8.43 mm 的旁路走线，其自身电感在那个频点上已经不是低阻抗，这颗电容等于没装。'
         + '本条把「距离敏感的单 IC 网」单独拿出来判；阈值按网名角色分档，每档的来源写在 why 里。'
         + '不属于任何角色的单 IC 网**逐条列出未判**，不静默算作通过。'
         + '已知边界：角色靠网名后缀识别，所以新设计若把 CPOUT 叫成别的名字，本条会不覆盖它 ——'
         + '那时它会出现在「未判」名单里，而不是变成通过。',
    fn: (d, g) => {
      const conns = Array.isArray(d.connections) ? d.connections : [];
      if (!conns.length) return { why: '设计文件没有 connections —— 无从判断哪颗电容给哪条支路做旁路' };
      // 角色表：只有**距离有物理意义**的单 IC 网才进来。
      // tolMil 的来源写在 src 里；这是设计限值，不是从本板实测反推出来的数字。
      const ROLES = [
        { re: /CPOUT$/i, tolMil: 100, src: 'MPU-6050 手册：CPOUT(pin 20) 外接 2.2nF，走线尽可能短' },
        { re: /REGOUT$/i, tolMil: 150, src: 'MPU-6050 手册：REGOUT(pin 10) 内部稳压器旁路，要求同上' },
      ];
      const isIC = (des) => /^U\d+$/.test(des);
      const isCap = (des) => /^C\d+$/.test(des);
      const byNet = new Map();
      for (const row of conns) {
        if (!Array.isArray(row) || row.length < 3) {
          return { why: `connections 里有形状不对的行，无法解读网表：${JSON.stringify(row)}` };
        }
        const [des, , net] = row;
        if (!byNet.has(net)) byNet.set(net, new Set());
        byNet.get(net).add(des);
      }
      const box = new Map(g.comps.map((c) => [c.des, c]));
      const gap = (a, b) => {
        const dx = a.x1 < b.x0 ? b.x0 - a.x1 : (b.x1 < a.x0 ? a.x0 - b.x1 : 0);
        const dy = a.y1 < b.y0 ? b.y0 - a.y1 : (b.y1 < a.y0 ? a.y0 - b.y1 : 0);
        return Math.hypot(dx, dy);
      };
      const misses = [];
      const judged = [];
      const notJudged = [];
      const noBox = [];
      for (const [net, desSet] of byNet) {
        const ics = [...desSet].filter(isIC);
        const caps = [...desSet].filter(isCap);
        const role = ROLES.find((r) => r.re.test(net));
        if (!role) {
          // 只登记「单 IC 且带电容」的网 —— 它们正是上一条判据排除掉、本条本该接手的那批。
          if (ics.length === 1 && caps.length) notJudged.push(`${net}(${caps.join('/')})`);
          continue;
        }
        if (!caps.length) {
          misses.push(`${net}: 网名匹配「${role.src}」，但网表上一颗电容都没有`);
          continue;
        }
        if (!ics.length) {
          return { why: `${net} 匹配到旁路角色，但网表上没有 IC —— 本条判据的结构假设不成立，不能硬判` };
        }
        for (const cp of caps) {
          const bc = box.get(cp);
          if (!bc) { noBox.push(`${net}: ${cp}`); continue; }
          for (const ic of ics) {
            const bi = box.get(ic);
            if (!bi) { noBox.push(`${net}: ${ic}`); continue; }
            const dd = gap(bi, bc);
            judged.push(`${net}: ${cp}→${ic} ${Math.round(dd)} mil / 限 ${role.tolMil}`);
            if (dd > role.tolMil) {
              misses.push(`${net}: ${cp} 距 ${ic} ${Math.round(dd)} mil > 限 ${role.tolMil} mil（${role.src}）`);
            }
          }
        }
      }
      const denom = `分母=${judged.length} 组「电容→IC」`
        + (notJudged.length ? `；未判 ${notJudged.length} 个单 IC 带电容网（不属于任何距离敏感角色，不算通过）[${notJudged.join(',')}]` : '');
      if (noBox.length) {
        return { why: `${[...new Set(noBox)].join(' / ')} 尺寸未知 —— 缺尺寸就不能判，不能当成通过（${denom}）` };
      }
      if (!judged.length) {
        return { why: `没有任何网匹配到距离敏感的旁路角色（已查 ${byNet.size} 个网）—— 这条判据在本设计上没有分母` };
      }
      return misses.length
        ? { ok: false, why: `${misses.join(' / ')}（${denom}）` }
        : { ok: true, value: `距离敏感旁路电容全部贴住（${judged.join('；')}）（${denom}）` };
    },
  },
  {
    id: 'acoustic_port_clear',
    kind: 'PCB',
    basis: 'MEMS 麦克风、压力传感器这类器件的封装内部自带一个开口（声孔 / 传感孔），'
         + '声音和气压必须经过它。开口上方若被铜或其它器件的封装体盖住，电气测试会全过、'
         + '成品却没有声音。这一档 EDA 的通用间距检查结构性覆盖不到 —— 它查「导体与导体」，'
         + '不查「封装内部的非导体开口有没有被别的东西盖住」；本项目的 DRC 把它误报成 '
         + '`Slot Region to Track`，而流水线的图元索引里根本没有这个对象。'
         + '所以只能由设计文件显式声明（_copperVoids），由本判据审：声明的盒子必须落在'
         + '被它保护的器件占位之内，且不许有任何别的器件封装体侵入。',
    fn: (d, g) => {
      const V = d._copperVoids;
      if (!Array.isArray(V) || V.length === 0) {
        return { why: '设计文件没有 _copperVoids —— 本设计未声明任何封装内部开口。'
          + '这不是「已确认没有开口」：本审计读不到封装内部几何，'
          + '一个自带声孔却没有声明的器件在这里查不出来。已知盲区，不计入通过。' };
      }
      // 先把声明本身验一遍。退化盒（x1<=x0 / y1<=y0）会让下面的 overlap() 恒返回 0，
      // 于是「0 个器件遮挡」会被读成「开口通畅」—— 与 antenna_band_empty 踩过的是同一个坑：
      // 分母为空却给出「全清」结论。
      const bad = [];
      for (let i = 0; i < V.length; i++) {
        const v = V[i] || {};
        const tag = `_copperVoids[${i}]`;
        for (const k of ['x0', 'y0', 'x1', 'y1']) {
          if (!Number.isFinite(v[k])) bad.push(`${tag}.${k}=${JSON.stringify(v[k])} 不是有限数`);
        }
        if (Number.isFinite(v.x0) && Number.isFinite(v.x1) && !(v.x1 > v.x0)) {
          bad.push(`${tag} x 方向倒置或退化：x0=${v.x0} ≥ x1=${v.x1}`);
        }
        if (Number.isFinite(v.y0) && Number.isFinite(v.y1) && !(v.y1 > v.y0)) {
          bad.push(`${tag} y 方向倒置或退化：y0=${v.y0} ≥ y1=${v.y1}`);
        }
        if (v.inflateMil != null && !(Number.isFinite(v.inflateMil) && v.inflateMil >= 0)) {
          bad.push(`${tag}.inflateMil=${JSON.stringify(v.inflateMil)} 必须是非负数`);
        }
        if (!v.why || String(v.why).trim() === '') {
          bad.push(`${tag} 没有 why —— 没有出处就没有复核依据，这个盒子凭什么在这儿`);
        }
      }
      if (bad.length) {
        return { ok: false, why: '开口声明本身无效，任何「没人遮挡」的结论都不可信：' + bad.join('；') };
      }
      const hits = [];
      let comparisons = 0;
      let declaredOpenings = 0;
      for (let i = 0; i < V.length; i++) {
        const v = V[i];
        const inf = Number.isFinite(v.inflateMil) ? v.inflateMil : 0;
        const ko = {
          x0: v.x0 - inf, x1: v.x1 + inf,
          y0: v.y0 - inf, y1: v.y1 + inf, des: `void[${i}]`,
        };
        const owner = v.owner == null ? null : String(v.owner);
        const ob = owner ? g.comps.find((c) => c.des === owner) : null;
        if (owner && !ob) {
          hits.push(`_copperVoids[${i}] 自称属于 ${owner}，但 _placement 里没有这个位号`
            + ' —— 这段声明没有对象，它保护的可能是一块空地');
          continue;
        }
        declaredOpenings++;
        if (ob) {
          const insideOwner = v.x0 >= ob.x0 - 0.5 && v.x1 <= ob.x1 + 0.5
            && v.y0 >= ob.y0 - 0.5 && v.y1 <= ob.y1 + 0.5;
          if (!insideOwner) {
            hits.push(`_copperVoids[${i}] 的开口 [${v.x0},${v.y0}]-[${v.x1},${v.y1}] 不在 ${owner} 的占位 `
              + `[${Math.round(ob.x0)},${Math.round(ob.y0)}]-[${Math.round(ob.x1)},${Math.round(ob.y1)}] 内`
              + ' —— 它保护的是别处');
          }
        }
        for (const b of g.comps) {
          if (owner && b.des === owner) continue;   // 开口在它自己的封装体内，属正常
          comparisons++;
          const a = overlap(b, ko, 0);
          if (a > 0) {
            hits.push(`${b.des} 的封装体侵入 ${owner || `void[${i}]`} 的开口 ${Math.round(a)} mil²`
              + `（含 ${inf} mil 余量）—— 器件盖住开口和铺铜盖住开口同样致命`);
          }
        }
      }
      const denom = `分母=${declaredOpenings} 个声明开口 / ${comparisons} 次「开口 × 器件占位」求交`;
      return hits.length
        ? { ok: false, why: `${hits.join(' / ')}（${denom}）` }
        : { ok: true, value: `${declaredOpenings} 个封装开口位置自洽、且无器件封装体遮挡（${denom}）` };
    },
  },
    {
      id: 'board_shape_declared',
      kind: 'PCB',
      basis: '上面十三条里没有任何一条问过「这块板为什么是这个尺寸」。'
           + '于是板宽从 1300 改到 1625，十三条全绿——而「板框是器件推出来的」'
           + '与「板框被核对过」是两个不同的结论。所以要设计文件显式声明'
           + '尺寸来历（_formFactor），并与**实际**板框、与**实测**的器件云四边留白逐项对账。'
           + '第二件事才是关键：它把「留白有多大」从巧合变成一个必须维护的数字。',
      fn: (d, g) => {
        const F = d._formFactor;
        if (!F || typeof F !== 'object' || Array.isArray(F)) {
          return { why: '设计文件没有 _formFactor —— 板框尺寸没有声明来历。'
            + '「板框是器件推出来的」和「板框被核对过」不是同一个结论：'
            + '缺这一项时，板子改成任何尺寸本审计都不会有意见。已知盲区，不计入通过。' };
        }
        const bad = [];
        const num = (v) => typeof v === 'number' && Number.isFinite(v);
        const tol = F.toleranceMil;
        if (!num(tol) || tol < 0) bad.push(`toleranceMil=${JSON.stringify(tol)} 不是非负有限数`);
        // 【容差必须有上限】实测 2026-11-27（对抗性审查）：这个字段原来无上界，
        // 写 100 mil 就能让四边留白的对账恒为真。而川实测差异只有十几 mil 量级。
        // 容差一旦能吸收真实测量误差，这条对账就不再代表任何东西。
        const TOL_MAX = 1;
        if (num(tol) && tol > TOL_MAX) {
          bad.push(`toleranceMil=${tol} 太大（上限 ${TOL_MAX}）—— 容差能吸收真实测量误差时，对账形同虚设`);
        }
        if (typeof F.why !== 'string' || !F.why.trim()) bad.push('why 为空 —— 尺寸来历必须写成一句可核对的话');
        const dm = F.declaredMil || {};
        const W = Number(d.boardWidthMil), H = Number(d.boardHeightMil);
        const T = num(tol) && tol >= 0 ? tol : 0;
        const cmp = [];
        if (!num(dm.w) || dm.w <= 0) bad.push(`declaredMil.w=${JSON.stringify(dm.w)} 不是正数`);
        else cmp.push(['板宽', dm.w, W]);
        if (!num(dm.h) || dm.h <= 0) bad.push(`declaredMil.h=${JSON.stringify(dm.h)} 不是正数`);
        else cmp.push(['板长', dm.h, H]);

        // 实测器件云四边留白。板框是 X∈[0,W]、Y∈[-H,0]。
        // 留白为负意味着器件超出板边（天线悬出），那不是错，但必须写进声明。
        if (Array.isArray(g.comps) && g.comps.length) {
          const minX = Math.min(...g.comps.map((b) => b.x0));
          const maxX = Math.max(...g.comps.map((b) => b.x1));
          const minY = Math.min(...g.comps.map((b) => b.y0));
          const maxY = Math.max(...g.comps.map((b) => b.y1));
          const measured = { left: minX, right: W - maxX, top: -maxY, bottom: minY + H };
          const decl = F.marginsMil || {};
          for (const k of ['left', 'right', 'top', 'bottom']) {
            if (!num(decl[k])) { bad.push(`marginsMil.${k}=${JSON.stringify(decl[k])} 没声明`); continue; }
            // 【留白必须是整数】实测 2026-11-27：这四个数当时是「运一遍审计、把输出贴回设计」
            // 得到的（设计文件自己就写着「留白数字是用审计自己的尺子量的」），
            // 所以限差 0.5 mil 的对账在当时是**恒真**的。让它带小数就等于留下一个审计回声的指纹。
            // 设计意图是人定的整数（「每侧至少 276 mil」那种），不是四位小数的测量值。
            if (!Number.isInteger(decl[k])) {
              bad.push(`marginsMil.${k}=${decl[k]} 不是整数 —— 留白是设计意图，不该是审计是输出的回声`);
              continue;
            }
            cmp.push([`留白.${k}`, decl[k], measured[k]]);
          }
        } else {
          bad.push('读不到任何器件几何 —— 没有器件就算不出留白，不能当成通过');
        }
        for (const [name, declared, actual] of cmp) {
          if (Math.abs(declared - actual) > T) {
            bad.push(`${name} 声明 ${Math.round(declared * 10) / 10} 实测 ${Math.round(actual * 10) / 10}`
              + ` 差 ${Math.round(Math.abs(declared - actual) * 10) / 10} > 容差 ${T}`);
          }
        }
        const denom = `分母=${cmp.length} 项对账（2 边 + 4 边留白），容差 ${T} mil`
          + `；板 ${W}×${H} mil，器件 ${Array.isArray(g.comps) ? g.comps.length : 0} 件`;
        return bad.length
          ? { ok: false, why: `${bad.join(' / ')}（${denom}）` }
          : { ok: true, value: `板框 ${W}×${H} mil 与声明一致，四边留白与实测一致（${denom}）`
              + `。【这是一把**回归锁**，不是独立验证】留白与实测用的是同一份 SIZES 表，`
              + `它能抵住「布局被改而留白没跟着改」，但**不能**证明尺子本身准不准 ——`
              + `后者要靠 fabcheck 对**产物 GKO 实测板框**的对账。来历：${String(F.why).slice(0, 60)}` };
      },
    },
];

// ── 主流程 ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const TO_JSON = args.includes('--json');
// 显式解析而不是 find(!startsWith('--'))：`--sizes <path>` 的值不以 `--` 开头，
// 会被那个写法当成位置参数。第一版就踩了，且在没有 --sizes 时把设计路径也排除掉
// （indexOf 返回 -1，-1+1 = 0 正好跳过了 args[0]）。
let designPath = null;
let sizesPath = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--sizes') { sizesPath = args[++i] ?? null; continue; }
  if (args[i].startsWith('--')) continue;
  if (!designPath) designPath = args[i];
}

// 人类可读输出在 --json 模式下全部改走 stderr，stdout 只留一个 JSON ——
// 否则调用方 `JSON.parse(stdout)` 会被表头那行「摆放合规审计」噎死。
const say = TO_JSON ? (...a) => console.error(...a) : (...a) => console.log(...a);

if (!designPath) {
  console.error('用法: node scripts/audit-placement.mjs <design.json> [--sizes <json>] [--json]');
  process.exit(2);
}
let design;
try {
  design = JSON.parse(fs.readFileSync(designPath, 'utf8'));
} catch (e) {
  console.error(`读不到设计文件 ${designPath}: ${e.message}`);
  process.exit(2);
}

// --sizes 覆盖表（换料/重测后用）：{ "<lcsc>": { w, h } }
const si = args.indexOf('--sizes');
if (si >= 0 && args[si + 1]) {
  try {
    const extra = JSON.parse(fs.readFileSync(args[si + 1], 'utf8'));
    let n = 0;
    for (const [k, v] of Object.entries(extra)) {
      if (typeof v?.w === 'number' && typeof v?.h === 'number') { SIZES[k] = { w: v.w, h: v.h, note: 'override' }; n++; }
    }
    say(`  尺寸覆盖表载入 ${n} 条：${args[si + 1]}`);
  } catch (e) {
    console.error(`读不到尺寸覆盖表: ${e.message}`);
    process.exit(2);
  }
}

const W = Number(design.boardWidthMil), H = Number(design.boardHeightMil);
if (!(W > 0 && H > 0)) { console.error('设计文件缺 boardWidthMil / boardHeightMil'); process.exit(2); }
if (!design._placement || typeof design._placement !== 'object') {
  console.error('设计文件缺 _placement —— 没有摆放可审计');
  process.exit(2);
}

const comps = [];
const unknown = [];
for (const [des, p] of Object.entries(design._placement)) {
  const c = (design.components || []).find((x) => x.des === des);
  const lcsc = c?.lcsc || '';
  const gg = geom(des, p, lcsc);
  if (!gg) unknown.push(`${des}(${lcsc || '无料号'})`);
  else comps.push(gg);
}

say('');
say(`  摆放合规审计  ${path.basename(designPath)}`);
say(`  板 ${W} × ${H} mil = ${mm(W).toFixed(1)} × ${mm(H).toFixed(1)} mm`);
say(`  已定几何 ${comps.length} 个器件 / 尺寸未知 ${unknown.length} 个`);
if (unknown.length) say(`  ⚠ 尺寸未知（不猜，直接判无法判定）：${unknown.join(', ')}`);
say('');
say(`  ${'判据'.padEnd(24)} ${'类'.padEnd(6)} ${'结果'.padEnd(6)} 实测 / 原因`);
say('  ' + '─'.repeat(104));

const results = [];
let nPass = 0, nFail = 0, nSkip = 0, hardFail = 0;
for (const r of RULES) {
  let res;
  try { res = r.fn(design, { comps }); } catch (e) { res = { why: `判据自己抛异常: ${e.message}` }; }
  let tag, verdict, line;
  if (res.ok === true) { tag = '通过'; verdict = 'pass'; nPass++; line = res.value || ''; }
  else if (res.ok === false) {
    tag = '不通过'; verdict = 'fail'; nFail++; if (r.kind === 'PCB') hardFail++; line = res.why || '';
  } else { tag = '无法判定'; verdict = 'unknown'; nSkip++; line = res.why || ''; }
  results.push({ id: r.id, kind: r.kind, verdict, detail: line });
  const kindTag = `[${r.kind}]`;
  say(`  ${r.id.padEnd(24)} ${kindTag.padEnd(6)} ${tag.padEnd(6)} ${line}`);
  if (tag !== '通过') say(`  ${''.padEnd(24)} ${''.padEnd(6)}        └ 依据：${r.basis}`);
}
say('  ' + '─'.repeat(104));
const total = RULES.length;
say(`  合计 ${total} 条：通过 ${nPass} / 不通过 ${nFail}（其中 [PCB] 类 ${hardFail}）/ 无法判定 ${nSkip}`);
say(`  器件 ${comps.length} 个参与几何判定；尺寸未知 ${unknown.length} 个未参与（不计入「通过」分子，也不计入「不通过」分子）`);

let code, banner;
if (nFail > 0 && hardFail > 0) {
  code = 1; banner = `PLACEMENT=FAIL  ${hardFail} 条 [PCB] 类判据不通过 —— 这些是 PCB 摆位就能修的真缺陷`;
} else if (nSkip > 0 || unknown.length > 0) {
  code = 2; banner = `PLACEMENT=NOSAMPLE  有 ${nSkip + unknown.length} 项无法判定（缺尺寸或判据输入不足）—— 不能当作通过`;
} else if (nFail > 0) {
  code = 0; banner = `PLACEMENT=WARN  [PCB] 类全过，${nFail} 条 [机构] 类不通过 —— 需结构件协同，不是 PCB 缺陷`;
} else {
  code = 0; banner = 'PLACEMENT=PASS  全部判据通过';
}

if (TO_JSON) {
  process.stdout.write(JSON.stringify({
    design: path.basename(designPath),
    board: { w: W, h: H, mmW: +mm(W).toFixed(2), mmH: +mm(H).toFixed(2) },
    rules: results,
    summary: { total, pass: nPass, fail: nFail, failPcb: hardFail, unknown: nSkip,
               sizedComps: comps.length, unsizedComps: unknown.length },
    exitCode: code, banner,
  }) + '\n');
} else {
  say('\n  ' + banner);
}
process.exit(code);
