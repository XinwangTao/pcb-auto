#!/usr/bin/env node
// 闸门：preVia 给「被包围 GND 焊盘」打孔前必须**实测焊盘尺寸**，装不下就不打。
//
// 为什么要有这道闸门：
//   `preVia` 的判据 `(hasUp && hasDown) || (hasLeft && hasRight)` 只问「上下/左右有没有
//   邻居」，完全不问焊盘自己有多大。实测代价（out/ESP32S3_Wireless_Mic_V5-20261126-203952，
//   2026-11-26T20:50:22+08:00）：U3(MAX98357A) 是 0.5mm 间距，相邻盘心 19.7 mil，那一排
//   中间引脚天然左右都有邻居 ⇒ 被判成 EP 焊盘 ⇒ 在实测只有 10x24 mil 的普通引脚上打了
//   外径 19.7 mil 的孔（`epViaAt` 的 near 全在 19.4~25.6）⇒ 孔比焊盘还宽，必然压到相邻
//   引脚的铜。DRC 因此报 4 条 `Clearance Error | SMD Pad to Via cur=0`
//   （625/-2041、591/-2095、729/-1744、729/-1676，与 epViaAt 逐点对上），cur=0 = 两块铜
//   直接相接 = 短路。这块板因此作废。
//
// 这道闸门要钉住的是**四件事**，缺一件它就会变成「不会失败的测试」：
//   ① 装不下必须拦（padTooSmall），且不许 create；
//   ② 读不到包围盒也必须拦（noBBox）—— 盲打正是那次短路的成因；
//   ③ **装得下必须放行**（positive control）。只测①②的话，一个「永远返回 false」的
//      闸门也能全绿 —— 那是把短路换成了 GND 完全没地孔，同样是缺陷；
//   ④ 分母必须闭合：candidates === count + skipped，否则读数无法解释。
//
// 退出码契约：0 通过 / 1 内容不满足契约 / 2 环境问题（读不到源、锚点变了）。
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'scripts', 'pipeline3.js');

function bail(msg) { console.log('  EPVIA-SIZEGATE=ENVSKIP  ' + msg); process.exit(2); }
function contractFail(msg) { console.log('  EPVIA-SIZEGATE=FAIL  ' + msg); process.exit(1); }

let src;
try { src = fs.readFileSync(SRC, 'utf8'); }
catch (e) { bail(`读不到 ${path.relative(ROOT, SRC)}：${e.message}`); }

// ── 抽取：尺寸闸门整段（从常量声明到 epVias 汇总）────────────────────────────
const START = '  const EP_VIA_H = 11.8, EP_VIA_D = 19.7;';
const ENDMARK = "    note: 'candidates = count + skipped；skipped 说明判据挑中但物理上打不下孔' });";
const a = src.indexOf(START);
if (a < 0) contractFail('找不到起锚点 `const EP_VIA_H = 11.8, EP_VIA_D = 19.7;` —— 尺寸闸门不在了');
if (src.indexOf(START, a + 1) >= 0) contractFail('起锚点出现多次，无法确定抽哪一段');
const b = src.indexOf(ENDMARK, a);
if (b < 0) contractFail('找不到止锚点（epVias 汇总行的 note 字段）');
const block = src.slice(a, b + ENDMARK.length);
for (const needle of ['getPrimitivesBBox', 'EP_VIA_NEED', "log('epViaSkip'", 'padTooSmall', 'noBBox',
  'pcb_PrimitiveVia.create', "log('epVias'"]) {
  if (!block.includes(needle)) contractFail(`抽到的块里没有 ${needle} —— 抽错段了，闸门在验空气`);
}
// 反证前提：魔数必须已经从 create 调用里消失，否则 IS_PATCHED 判据无从谈起
if (block.includes('create(\'GND\', vx, vy, 11.8, 19.7)')) {
  contractFail('create 调用仍是裸魔数 11.8/19.7 —— 尺寸闸门没接上');
}

// ── 跑真实代码块：注入 padList / eda 桩，收集 log ─────────────────────────────
const FIXED = '0a8f38cbb768393d';
function runBlock(pads, bbMap) {
  const body = `
    const padList = ${JSON.stringify(pads)};
    const bbMap = ${JSON.stringify(bbMap)};
    let viaCount = 0;
    const epViaRecs = [];
    const logs = [];
    const created = [];
    const log = (s, v) => { logs.push({ s, v }); };
    const enclosed = padList.filter((p) => p.enclosed);
    const eda = {
      pcb_Primitive: {
        getPrimitivesBBox: async (ids) => {
          const hit = bbMap[String(ids[0])];
          return hit === undefined ? null : hit;
        },
      },
      pcb_PrimitiveVia: {
        create: async (net, x, y, h, d) => {
          created.push({ net, x, y, h, d });
          return { getState_PrimitiveId: () => '${FIXED}' };
        },
      },
    };
    ${block}
    return { viaCount, epViaRecs, logs, created, candidates: enclosed.length };
  `;
  const fn = new Function('return (async () => {' + body + '})()');
  return fn();
}

// pad：id/net/x/y/num/enclosed ；bb：{minX,maxX,minY,maxY}
const PAD_SMALL = { id: 'p1', net: 'GND', x: 640.2, y: -2159.1, num: '2', enclosed: true };
const NB_L = { id: 'p2', net: 'AMP_LRCLK', x: 620.5, y: -2159.1, num: '3', enclosed: false };
const NB_R = { id: 'p3', net: 'AMP_BCLK', x: 659.9, y: -2159.1, num: '4', enclosed: false };
const BB_SMALL = { minX: 635.2, maxX: 645.2, minY: -2171.1, maxY: -2147.1 };  // 10 x 24 mil（实测值）
const PAD_BIG = { id: 'q1', net: 'GND', x: 650, y: -2000, num: '17', enclosed: true };
const BB_BIG = { minX: 620, maxX: 680, minY: -2030, maxY: -1970 };            // 60 x 60 mil
const BB_EDGE = { minX: 0, maxX: 31.7, minY: 0, maxY: 31.7 };                  // 恰好装得下
const BB_TINY = { minX: 0, maxX: 31.69, minY: 0, maxY: 40 };                   // 差 0.01 mil

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  [ok] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${extra ? '  ' + extra : ''}`); }
}
const skips = (r) => r.logs.filter((l) => l.s === 'epViaSkip').map((l) => l.v);
const summary = (r) => r.logs.filter((l) => l.s === 'epVias').map((l) => l.v)[0];

(async () => {
  // ── 场景 1：实测代价复现 —— 10x24 mil 的普通引脚，左右各有一个非 GND 邻居 ──
  {
    const r = await runBlock([PAD_SMALL, NB_L, NB_R], { p1: BB_SMALL });
    ok('[small] 不允许建孔', r.created.length === 0, `created=${r.created.length}`);
    ok('[small] count 记 0', r.viaCount === 0);
    ok('[small] 留了一条账', skips(r).length === 1, `skips=${skips(r).length}`);
    ok('[small] 理由是 padTooSmall', skips(r)[0] && skips(r)[0].why === 'padTooSmall', JSON.stringify(skips(r)[0]));
    const s = summary(r);
    ok('[small] epVias.count = 0', s && s.count === 0);
    ok('[small] candidates = 1', s && s.candidates === 1);
    ok('[small] skipped = 1', s && s.skipped === 1);
    ok('[small] 分母闭合 count+skipped===candidates', s && s.count + s.skipped === s.candidates,
      s ? `${s.count}+${s.skipped}=${s.count + s.skipped} vs ${s.candidates}` : 'no summary');
    ok('[small] 账里带实测尺寸', s && s.skipBy && s.skipBy.padTooSmall === 1, JSON.stringify(s && s.skipBy));
  }

  // ── 场景 2：读不到包围盒也必须拦（盲打就是那次短路的成因）──
  {
    const r = await runBlock([PAD_SMALL, NB_L, NB_R], {});   // bbMap 空 => 返回 null
    ok('[nobbox] 不允许建孔', r.created.length === 0, `created=${r.created.length}`);
    ok('[nobbox] 理由是 noBBox', skips(r)[0] && skips(r)[0].why === 'noBBox', JSON.stringify(skips(r)[0]));
    const s = summary(r);
    ok('[nobbox] 分母闭合', s && s.count + s.skipped === s.candidates, JSON.stringify(s));
    ok('[nobbox] skipBy.noBBox = 1', s && s.skipBy && s.skipBy.noBBox === 1, JSON.stringify(s && s.skipBy));
  }

  // ── 场景 3（positive control）：装得下必须放行 ───────────────────────────
  // 没有这一条，一个「永远拦」的闸门也能让上面 12 条全绿 —— 那是拿短路换掉全部地孔。
  {
    const r = await runBlock([PAD_BIG], { q1: BB_BIG });
    ok('[big] 必须建 1 个孔', r.created.length === 1, `created=${r.created.length}`);
    ok('[big] count = 1', r.viaCount === 1);
    ok('[big] 孔 11.8 / 盘 19.7', r.created[0] && r.created[0].h === 11.8 && r.created[0].d === 19.7,
      JSON.stringify(r.created[0]));
    ok('[big] 网是 GND', r.created[0] && r.created[0].net === 'GND');
    ok('[big] 没有跳过账', skips(r).length === 0, JSON.stringify(skips(r)));
    const s = summary(r);
    ok('[big] count=1 skipped=0 candidates=1', s && s.count === 1 && s.skipped === 0 && s.candidates === 1,
      JSON.stringify(s));
    ok('[big] 记了 padSize', r.logs.some((l) => l.s === 'epViaAt' && l.v && Array.isArray(l.v.padSize)),
      JSON.stringify(r.logs.filter((l) => l.s === 'epViaAt')));
  }

  // ── 场景 4：边界方向 —— 恰好 31.7 放行、31.69 拦 ────────────────────────
  // 判据写反（<= / >=）在这里会立刻现形；没有它，「装得下」的定义就是浮动的。
  {
    const rEdge = await runBlock([PAD_BIG], { q1: BB_EDGE });
    ok('[edge] 31.7 恰好放行', rEdge.created.length === 1, `created=${rEdge.created.length}`);
    const rTiny = await runBlock([PAD_BIG], { q1: BB_TINY });
    ok('[edge] 31.69 必须拦', rTiny.created.length === 0, `created=${rTiny.created.length}`);
    ok('[edge] 31.69 的理由是 padTooSmall', skips(rTiny)[0] && skips(rTiny)[0].why === 'padTooSmall');
  }

  // ── 场景 5：混合 —— 一个装不下、一个装得下，两边都要记账 ─────────────────
  {
    const r = await runBlock([PAD_SMALL, NB_L, NB_R, PAD_BIG], { p1: BB_SMALL, q1: BB_BIG });
    ok('[mixed] 只建 1 个孔', r.created.length === 1, `created=${r.created.length}`);
    ok('[mixed] 只跳 1 个', skips(r).length === 1, `skips=${skips(r).length}`);
    const s = summary(r);
    ok('[mixed] count=1 skipped=1 candidates=2', s && s.count === 1 && s.skipped === 1 && s.candidates === 2,
      JSON.stringify(s));
    ok('[mixed] 分母闭合', s && s.count + s.skipped === s.candidates);
  }

  // ── 场景 6：空候选集零代价（不许崩、也不许凭空造记录）────────────────────
  // 这一条单独列出是因为「空集合天然满足 assertEqual(0)」—— 必须配场景 3/5 才有意义。
  {
    const r = await runBlock([], {});
    const s = summary(r);
    ok('[empty] 不建孔', r.created.length === 0);
    ok('[empty] 摘要 count=0 skipped=0 candidates=0',
      s && s.count === 0 && s.skipped === 0 && s.candidates === 0, JSON.stringify(s));
    ok('[empty] 无 skip 记录', skips(r).length === 0);
  }

  console.log('');
  if (fail) { console.log(`  EPVIA-SIZEGATE=FAIL  ${fail} 条断言不通过 / 共 ${pass + fail}`); process.exit(1); }
  console.log(`  EPVIA-SIZEGATE=PASS  ${pass} 条断言全过（6 场景：拦小盘 · 拦无盒 · 放行大盘 · 边界方向 · 混合记账 · 空集零代价）`);
  process.exit(0);
})().catch((e) => { console.log('  EPVIA-SIZEGATE=FAIL  执行抛异常: ' + (e && e.stack || e)); process.exit(1); });
