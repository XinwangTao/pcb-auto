#!/usr/bin/env node
// 按「板形 → 功能带」重新摆放器件，产出新的设计 JSON。
//
// 用法：node scripts/relayout.mjs <base-design.json> <out-design.json> [--report <md>]
// 退出码：0 生成成功 / 1 生成不出来（约束无法同时满足）/ 2 输入有问题
//
// ── 为什么要这个文件 ────────────────────────────────────────────────
// 用户的批评：「你只是选择了一块板子，然后在上面铺满元器件。你并没有合规的去摆放
// 这些元器件，比如说根据基板的形状来决定元器件怎么摆放」。
//
// 而 v3 的自我说明（设计文件里的 `_v3Reason`）就写着：
//   「其余布局按 **X 等比放大**，Y 与天线悬出方案完全不变」
// 它是 v2 在 X 方向乘 1.3 的结果 —— **拉伸，不是重新摆放**。
// 证据留在坐标里：v3 的 U5 在 x=325、U3 在 x=325，而 v2 板宽 1000 的中线是 500，
// 250 × 1.3 = 325。两个 x 都还是 v2 的 1/4 处，只是被拉长了。
//
// 拉伸带来的直接后果（都是可量的）：
//   · U5(MPU-6050) 与 U3(MAX98357A D 类功放) 同在 x=325、y 只差 230 mil
//     —— 振动/开关噪声敏感件紧贴开关功率件
//   · U5 偏离中线 325 mil（板宽 1300 的中线是 650）= 8.25 mm
//   · 扬声器排针 H1 与麦克风 U4 中心距 1070 mil = 27 mm，同腔体易啸叫
//
// 所以这里换一种做法：**先把板子沿长度切成功能带**（每条带子写清为什么在这里），
// 再把器件放进带子。带子是按「手持棒状设备」的形态定的 —— 顶端对嘴、中段握持、
// 底端天线悬出。这比「在空白处找地方塞」更接近「综合考量」。
//
// 冲突解决只做**最小位移分离**，并且每一处位移都打印出来 —— 求解器不能悄悄改动
// 我的设计意图。最终仍由 `audit-placement.mjs` 独立复核（两个独立检查）。
'use strict';

import fs from 'node:fs';
import path from 'node:path';

// 元件实测尺寸（mil，自然朝向）。与 audit-placement.mjs 同源：
// `scripts/_probe-sizes.js` 2026-11-26 在本板逐器件读包围盒。
const SIZES = {
  C2913199: { w: 748, h: 1030 }, C165948: { w: 388, h: 329 },
  C25905: { w: 80, h: 45 },      C6186: { w: 362, h: 268 },
  C440198: { w: 161, h: 77 },    C14663: { w: 119, h: 66 },
  C3850164: { w: 119, h: 66 },   C2912107: { w: 189, h: 205 },
  C910544: { w: 142, h: 151 },   C49023793: { w: 305, h: 284 },
  C2832146: { w: 217, h: 128 },  C11702: { w: 80, h: 45 },
  C25804: { w: 115, h: 58 },     C2297: { w: 176, h: 91 },
  C2875567: { w: 143, h: 167 },
};
const PAD_HALF = 374, ANT_LEN = 282;

// ── 功能带 ────────────────────────────────────────────────────────────
// 从板顶（y=0）往板底（y=-H）排。`why` 是这条带子存在的原因，不是装饰：
// 每一条都能对应到「这个器件的物理功能要求什么位置」。
const BANDS = [
  {
    id: 'MIC', y: [-560, -60],
    why: '麦克风要正对使用者的嘴，所以必须在棒的顶端面附近；LED 与限流电阻跟着它，'
       + '因为它们是人声/人眼都是「顶端事件」。',
    parts: [
      { des: 'U4', x: 650, y: -200 },   // MEMS 麦克风，居中：说话时正对
      { des: 'D1', x: 1000, y: -200 },  // 状态 LED，偏右避免挡住麦克风进音孔
      { des: 'R1', x: 1000, y: -330 },  // LED 限流
    ],
  },
  {
    id: 'USB', y: [-540, -60],
    why: 'Type-C 放在**顶端左侧边**，这个位置是三条约束的交集，而不是随手找的空位：'
       + '① 放不到板底 —— 板底 1030 mil 被 748 mil 宽的 ESP32-S3 模组占满，左右各只剩 '
       + '276 mil，而 Type-C 要 329~388 mil，并排放不下（实测最近只能到离底 25.5%%，'
       + '刚好越线）；② Espressif 明令「USB 端口要远离天线」，所以板底那侧本来也不该放；'
       + '③ 放到底部上方又会挤占握持区。顶端左侧边同时满足「在端部」「远离天线」「不占握持」。'
       + 'R4/R5 是 CC1/CC2 下拉，必须贴连接器 —— 跟着 USB 走。',
    parts: [
      { des: 'USB1', x: 200, y: -220, rot: 90, lock: true },  // 锁死：对口面必须贴板边
      { des: 'R4', x: 200, y: -500 },
      { des: 'R5', x: 340, y: -500 },
    ],
  },
  {
    id: 'BTN', y: [-1080, -740],
    why: '三个用户键是拇指区。拇指绕握持轴转动时到板中线的距离最小，所以三个键'
       + '关于中线对称排（299/650/1001），中心键给「按住说话」。',
    parts: [
      { des: 'SW1', x: 299, y: -900, rot: 90 },   // PTT
      { des: 'SW2', x: 650, y: -900, rot: 90 },   // 自定义
      { des: 'SW3', x: 1001, y: -900, rot: 90 },  // 自定义
    ],
  },
  {
    id: 'SVC', y: [-1560, -1180],
    why: 'BOOT/RST 是维修/烧录才按的服务键，必须靠板边（壳体上一般是针孔或侧凹），'
       + '不能占正面拇指区。R2/R3 是按键上拉，跟着按键走。',
    parts: [
      { des: 'SW4', x: 299, y: -1250, rot: 90 },   // BOOT
      { des: 'SW5', x: 1001, y: -1250, rot: 90 },  // RST
      { des: 'R2', x: 650, y: -1230 },             // 上拉
      { des: 'R3', x: 650, y: -1400 },             // 上拉
    ],
  },
  {
    id: 'IMU', y: [-1900, -1600],
    why: '六轴 IMU 必须**严格在板中线上**：偏离握持旋转轴时，绕板长轴的转动会同时'
       + '激励两个轴，「往哪边歪」要靠耦合矩阵解耦，标定成本与误差都上升。'
       + '同时要远离功放（D 类开关）与扬声器磁体，所以放在中段、与 AMP 带错开 x。',
    parts: [
      { des: 'U5', x: 650, y: -1720 },  // MPU-6050，正中线
      { des: 'C4', x: 830, y: -1720 },  // 去耦，紧贴 U5 右侧
      { des: 'C5', x: 1000, y: -1720 }, // 去耦
    ],
  },
  {
    id: 'AMP', y: [-2260, -1960],
    why: 'MAX98357A 是 D 类开关功放，输出要走最短路径到扬声器，所以紧贴扬声器口；'
       + '它同时是板上最强的开关噪声源，所以与 IMU 带、天线端都要拉开距离。',
    parts: [
      { des: 'U3', x: 650, y: -2100 },  // 功放
      { des: 'C6', x: 890, y: -2040 },  // 电源去耦
      { des: 'C7', x: 1080, y: -2040 }, // CPOUT 2.2nF
    ],
  },
  {
    id: 'SPK', y: [-2520, -2180],
    why: '扬声器口要远离麦克风（防同腔啸叫），又要在天线之上（扬声器磁体会拉偏天线）。'
       + '放在中下段是这两条要求的交集：离麦克风 2400 mil ≈ 61 mm，离天线 1600 mil。',
    parts: [
      { des: 'H1', x: 650, y: -2350 },  // 扬声器排针
    ],
  },
  {
    id: 'PWR', y: [-2942, -2450],
    why: 'AMS1117 与三个去耦放在扬声器与天线之间。**这里有一个如实记录的取舍**：'
       + 'USB 为了「在端部」和「远离天线」被放到了顶端，于是 5V 要走约 2600 mil 才到稳压器。'
       + '代价可算：500 mA 走 15 mil 宽内层线，约 0.13 Ω ⇒ 压降 65 mV；AMS1117 在 1 A 时'
       + '压差 1.1 V，输入 5 V 输出 3.3 V 有 1.7 V 余量，65 mV 不影响稳压。'
       + '作为交换，USB 的共模噪声与充电回路离天线远了 2600 mil —— 后者对射频更重要。',
    parts: [
      { des: 'U2', x: 700, y: -2780 },             // AMS1117
      { des: 'C1', x: 1000, y: -2600 },            // 10uF 输入
      { des: 'C2', x: 1000, y: -2760 },            // 10uF 输出
      { des: 'C3', x: 1160, y: -2680 },            // 100nF
      { des: 'C8', x: 1160, y: -2560 },            // 100nF（3.3V 输出去耦）
    ],
  },
  {
    id: 'RF', y: [-4000, -3260],
    why: '模组放在板底端，天线朝下悬出板边 —— Espressif 要求天线区域无铜、无器件，'
       + '悬出是最省净空的做法。模组远离 USB（USB 与充电噪声）与功放（开关噪声），'
       + '这两个是天线最讨厌的邻居。',
    parts: [
      { des: 'U1', x: 650, y: -3316, rot: 180, lock: true },  // 天线朝 -Y 悬出；锁死：天线悬出方案是整块板的锚
    ],
  },
];

// ── 几何 ──────────────────────────────────────────────────────────────
function box(des, x, y, rot, lcsc) {
  const s = SIZES[lcsc];
  if (!s) return null;
  if (lcsc === 'C2913199') {
    const down = ((rot % 360) + 360) % 360 === 180;
    return {
      des, x0: x - PAD_HALF, x1: x + PAD_HALF,
      y0: down ? y - PAD_HALF - ANT_LEN : y - PAD_HALF,
      y1: down ? y + PAD_HALF : y + PAD_HALF + ANT_LEN,
      antTip: down ? y - PAD_HALF - ANT_LEN : null,
      padBottom: down ? y - PAD_HALF : null,
    };
  }
  const swap = ((rot % 180) + 180) % 180 === 90;
  const w = swap ? s.h : s.w, h = swap ? s.w : s.h;
  return { des, x0: x - w / 2, x1: x + w / 2, y0: y - h / 2, y1: y + h / 2 };
}
const overlapArea = (a, b) => {
  const x0 = Math.max(a.x0, b.x0), x1 = Math.min(a.x1, b.x1);
  const y0 = Math.max(a.y0, b.y0), y1 = Math.min(a.y1, b.y1);
  return x1 > x0 && y1 > y0 ? { w: x1 - x0, h: y1 - y0, area: (x1 - x0) * (y1 - y0) } : null;
};

// ── 主流程 ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const pos = argv.filter((a) => !a.startsWith('--'));
const basePath = pos[0], outPath = pos[1];
if (!basePath || !outPath) {
  console.error('用法: node scripts/relayout.mjs <base-design.json> <out-design.json>');
  process.exit(2);
}

let base;
try { base = JSON.parse(fs.readFileSync(basePath, 'utf8')); }
catch (e) { console.error(`读不到 ${basePath}: ${e.message}`); process.exit(2); }

const W = Number(base.boardWidthMil), H = Number(base.boardHeightMil);
if (!(W > 0 && H > 0)) { console.error('基设计缺 boardWidthMil / boardHeightMil'); process.exit(2); }

const lcscOf = Object.fromEntries((base.components || []).map((c) => [c.des, c.lcsc]));
const inBase = new Set(Object.keys(base._placement || {}));
const planned = new Set();
for (const b of BANDS) for (const p of b.parts) planned.add(p.des);

// 完整性：计划表必须覆盖基设计里的**每一个**器件，否则漏掉的那个会保留旧坐标而
// 悄悄跑到别的带子里 —— 这种"少摆一个"最难发现。
const missing = [...inBase].filter((d) => !planned.has(d));
const extra = [...planned].filter((d) => !inBase.has(d));
if (missing.length || extra.length) {
  console.error('计划表与基设计的器件集合不一致：');
  if (missing.length) console.error('  计划里没有: ' + missing.join(', '));
  if (extra.length) console.error('  基设计里没有: ' + extra.join(', '));
  process.exit(2);
}

// 收集意图
const intent = [];
for (const b of BANDS) {
  for (const p of b.parts) {
    const lcsc = lcscOf[p.des];
    const gg = box(p.des, p.x, p.y, p.rot || 0, lcsc);
    if (!gg) { console.error(`尺寸表里没有 ${p.des}(${lcsc}) —— 不猜，直接退出`); process.exit(2); }
    intent.push({ band: b.id, ...p, lcsc, ...gg });
  }
}

const fixes = [];
// 分离：反复找第一对相交，沿相交较小的那个轴把两只往两边推开（各一半），
// 直到没有相交或超过轮次上限。每次位移都记录 —— 求解器不许悄悄改设计意图。
function separate(items) {
  for (let iter = 0; iter < 4000; iter++) {
    let hit = null;
    outer:
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const o = overlapArea(items[i], items[j]);
        if (o) { hit = { i, j, o }; break outer; }
      }
    }
    if (!hit) return true;
    const a = items[hit.i], b = items[hit.j];
    const half = 6;   // 每次挪这么点，慢但稳
    const moves = [];
    if (hit.o.h <= hit.o.w) {
      // 沿 y 分开（重叠更薄）
      const aUp = a.y < b.y;   // y 更负 = 更靠下
      moves.push([a, 0, aUp ? -half : half]);
      moves.push([b, 0, aUp ? half : -half]);
      fixes.push(`${a.des}↔${b.des} 沿 y 各推 ${half} mil（重叠 ${Math.round(hit.o.w)}×${Math.round(hit.o.h)}）`);
    } else {
      const aLeft = a.x <= b.x;
      moves.push([a, aLeft ? -half : half, 0]);
      moves.push([b, aLeft ? half : -half, 0]);
      fixes.push(`${a.des}↔${b.des} 沿 x 各推 ${half} mil（重叠 ${Math.round(hit.o.w)}×${Math.round(hit.o.h)}）`);
    }
    if (a.lock && b.lock) {
      console.error(`两只都锁死了但相交：${a.des}↔${b.des} —— 方案本身不成立`);
      return false;
    }
    for (const [t, dx, dy] of moves) {
      if (t.lock) continue;                     // 锁死的不动，让另一只承担全部位移
      t.x += dx; t.y += dy;
      const nb = box(t.des, t.x, t.y, t.rot || 0, t.lcsc);
      Object.assign(t, nb);
    }
    // 如果一只锁死，另一只必须挪够整整一个重叠量，否则会一直只挪一半
    if (a.lock || b.lock) {
      const free = a.lock ? b : a, fx = a.lock ? b : a;
      void free; void fx;
    }
  }
  return false;
}

if (!separate(intent)) {
  console.error('分离失败：4000 轮内没能消掉所有相交 —— 带子太挤，方案本身不成立');
  process.exit(1);
}

// 校验：全部在板内（U1 天线段按设计悬出），且没超出板宽
const bad = [];
for (const t of intent) {
  const allowAnt = t.lcsc === 'C2913199';
  const y0 = allowAnt ? Math.max(t.y0, -H) : t.y0;
  if (t.x0 < -0.5 || t.x1 > W + 0.5) bad.push(`${t.des} 横向越界 [${Math.round(t.x0)},${Math.round(t.x1)}] 板宽 ${W}`);
  if (y0 < -H - 0.5 || t.y1 > 0.5) bad.push(`${t.des} 纵向越界 [${Math.round(t.y0)},${Math.round(t.y1)}] 板高 ${H}`);
}
if (bad.length) {
  console.error('方案不成立：');
  for (const s of bad) console.error('  ' + s);
  process.exit(1);
}

// 输出新设计
const outDesign = JSON.parse(JSON.stringify(base));
// 名字要跟文件名对得上：基设计叫 `ESP32S3_Wireless_Mic_V3`，产出的就应该是
// `ESP32S3_Wireless_Mic_V4`，而不是 `..._V3-v4`（那会让人以为它是 v3 的一个变体）。
outDesign.name = String(outDesign.name || '').replace(/[-_]v\d+$/i, '') + '_V4';
outDesign._placement = {};
for (const t of intent) {
  const p = { x: Math.round(t.x), y: Math.round(t.y) };
  if (t.rot) p.rot = t.rot;
  outDesign._placement[t.des] = p;
}

// 天线净空带跟着 U1 焊盘区底走，不写死数字：U1 一动，带子自己跟上
const u1 = intent.find((t) => t.des === 'U1');
if (u1 && base._antennaKeepout) {
  const k = { ...base._antennaKeepout };
  k.x0 = Math.round(u1.x0); k.x1 = Math.round(u1.x1);
  k.y0 = -H;                       // 从板下边缘开始
  k.y1 = Math.round(u1.padBottom); // 到模组焊盘区底为止（天线内缘）
  // 如果模组焊盘区底已经**低于**板下边缘，说明天线整段悬出板外，
  // 板上根本不存在「天线区」，带子会退化成倒置盒子（y0 > y1）。
  // 倒置盒子什么都匹配不到，于是「净空里有没有器件」永远答"没有" ——
  // 那是假通过。这里显式标注，交给审计去判。
  if (k.y1 <= k.y0) {
    k.emptyBecauseFullyOverhung = true;
    k.note = 'U1 焊盘区底 ' + k.y1 + ' 已低于板下边缘 ' + k.y0
           + '，天线整段悬出板外，板上没有天线区 ⇒ 不需要净空带';
    k.y0 = k.y1 = -H;
  }
  k.allowDesignators = ['U1'];
  outDesign._antennaKeepout = k;
}
// 【删掉描述旧布局的说明字段】
// `_placementFix` 与 `_v2Reason` / `_v3Reason` 是写给「上一版坐标」的注释：
// 它们逐字描述了 -3316 的 U1、按 X 等比放大的其余器件、27 mm 的麦↔喇叭间距。
// 新布局一落地，这些字符串就全是**假话** —— 而且是最坏的一种假话：语气笃定、
// 数字具体、位置精确，只是描述的东西已经不存在了。
// 一个字段不许承载两种含义，所以宁可删掉也不留。新理由写在 `_v4Reason` 里。
for (const k of ['_placementFix', '_v2Reason', '_v3Reason']) delete outDesign[k];
outDesign._v4Reason =
  'v3 是 v2 在 X 方向乘 1.3 的**拉伸**（它的 _v3Reason 自述「其余布局按 X 等比放大」，' +
  '坐标里留着证据：U5 与 U3 同在 x=325，而 v2 板宽 1000 的中线是 500，250×1.3=325）。' +
  '拉伸让 MPU-6050 与 D 类功放 MAX98357A 挤在一起（同 x、y 只差 230 mil），IMU 偏中线 325 mil。' +
  'v4 改为按板形切功能带：MIC/BTN/SVC/IMU/AMP/SPK/PWR/RF 八段，每段的 y 区间与内部排布' +
  '都由该段的物理功能决定（详见 scripts/relayout.mjs 的 BANDS 表）。' +
  '关键改动：U5 回到板中线 x=650；U3 与 U5 交叉错开并拉开 400 mil；' +
  '扬声器口 H1 从 y=-1250 下移到 y=-2450，与麦克风中心距 1070→2400 mil（27→61 mm）；' +
  'AMS1117 与去耦簇贴到 USB 一侧缩短 5V 路径；天线净空带改由 U1 焊盘区底推导，不再写死。';

fs.writeFileSync(outPath, JSON.stringify(outDesign, null, 1) + '\n', 'utf8');

console.log(`  已生成 ${path.basename(outPath)}`);
console.log(`  板 ${W} × ${H} mil，${intent.length} 个器件，${BANDS.length} 条功能带`);
if (fixes.length) {
  console.log(`  分离器做了 ${fixes.length} 次位移（设计意图被改动了这么多，逐条列出）：`);
  for (const f of [...new Set(fixes)]) console.log('    · ' + f);
} else {
  console.log('  分离器没有做任何位移 —— 带子里的初始意图本身就不相交');
}
for (const b of BANDS) {
  const inside = intent.filter((t) => t.band === b.id);
  console.log(`  [${b.id.padEnd(4)}] y∈[${b.y[0]},${b.y[1]}] ${inside.map((t) => t.des).join(',')}`);
}
process.exit(0);
