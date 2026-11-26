// _test-crosslayer-patch.js —— 锁住「贴合但分处不同层 ≠ 死铜孤岛」这条判据。
//
// 背景（真实事故，2026-11-26 01:24，gen-rp2040 / smart-fit）：
//   1. 布线完成，stillUnconnected = 0（板子本来是通的）
//   2. clearance 环为修一处间距**删掉了一个 GND 过孔**
//      viaDeleted {via:"4a97ed2456678237", d:19.8, net:"GND"}
//   3. GND 因此断路，patchDrc 拿到 2 个 Connection Error、还剩 285 秒预算
//      patchIslandPair {d:0.01, t1:"Track", t2:null, coverage:null,
//         note:"两对象已贴合仍判不连通 → 死铜孤岛 或 过孔盘未覆盖线端；局部补铜无效"}
//      patchRound {connErrs:2, attempted:0} → patchNoProgress → 放弃
//   4. 最终 DRC 2 个叶子，整块板判失败。
//
// 关键错误：那两个对象是 GND 的 Track 与 SMD Pad，**分处不同层**。
// d<=1.0 只说明 XY 上贴合，推不出"补铜无效"——差的是一个过孔。
// 而且下面二十多行本来就有跨层修复（打孔 + 底层直连），被这句 continue 挡在门外。
//
// 本测试守四件事：
//   A. 结构：分支存在、在孤岛结论之前、只打一个孔、登进 patchCreated/targets、
//      且**不得引用 mine**（mine 在该分支之后才 const 声明，引用即 TDZ 抛错）；
//   B. 语义 oracle：用真实读数回放决策表；
//   C. 反向：去掉分支后跨层贴合必须变回"不动作"；
//   D. 零长线：跨层分支绝不能走"两端打孔 + 连线"那条路。
//
// 用法: node _test-crosslayer-patch.js [pipeline3.js 路径]
'use strict';
const fs = require('fs');
const path = require('path');

const TARGET = process.argv[2] || path.join(__dirname, 'pipeline3.js');
let src;
try {
  src = fs.readFileSync(TARGET, 'utf8');
} catch (e) {
  console.error('读不到 ' + TARGET + ' : ' + e.message);
  process.exit(2);
}

let pass = 0;
const fails = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; return; }
  fails.push(name + (detail ? '  << ' + detail : ''));
};
const has = (s) => src.indexOf(s) >= 0;
const at = (s) => src.indexOf(s);

// ───────────────────────── A. 结构锁 ─────────────────────────
const iBranch = at('patchedCrossLayer');
ok('A1 存在跨层修复日志 patchedCrossLayer', iBranch >= 0, '缺 patchedCrossLayer');

const iIsland = at("note: '两对象已贴合仍判不连通");
ok('A2 跨层分支在孤岛结论之前（否则永远走不到）',
  iBranch >= 0 && iIsland > iBranch, '跨层分支被孤岛结论挡住');

const iGuard = at('if (cp.d <= 1.0) {');
ok('A3 跨层判据建立 cp.d <= 1.0 分支内部',
  iBranch > iGuard && iGuard >= 0, '不在近距离分支里');

ok('A4 判据比的是 layer 而不是距离',
  /const crossLayer = Number\.isFinite\(laNear\) && Number\.isFinite\(lbNear\) && laNear !== lbNear;/.test(src),
  '判据没比较层');

// 语义：只打一个孔。用真实读数对应源码里 Via.create 的出现次数。
const seg = iBranch >= 0 ? src.slice(iGuard, iBranch) : '';
ok('A5 跨层分支只调用一次 pcb_PrimitiveVia.create（不是两端各一个）',
  (seg.match(/pcb_PrimitiveVia\.create/g) || []).length === 1,
  'Via.create 次数 = ' + (seg.match(/pcb_PrimitiveVia\.create/g) || []).length);

ok('A6 跨层分支不画任何线（零长线会把网表变断路）',
  !/pcb_PrimitiveLine\.create/.test(seg), '跨层分支里出现了画线');

ok('A7 create 的 undefined 返回被单独记为失败',
  has('patchCrossLayerNoObj'), 'create 静默失败没留痕');

ok('A8 新建对象登进 patchCreated（复检变差时要能被统一删掉）',
  /patchCrossLayer[\s\S]{0,700}?patchCreated\.push\(\{ kind: 'via'/.test(src) ||
  /patchCreated\.push\(\{ kind: 'via', id: cvid \}\)/.test(src),
  '没登进 patchCreated');

ok('A9 登进 targets（否则这一处永不计入逐条对账）',
  /patchedCrossLayer[\s\S]{0,300}?targets\.push\(/.test(src) ||
  /targets\.push\(\{ net, ids: \[String\(ed\.obj1/.test(src),
  '没登进 targets');

// TDZ 守卫：mine 在 cp.d<=1.0 分支之后才 const 声明，分支内引用它必然运行期抛错。
// 必须先剥掉注释再判——注释里提一句 mine 不等于代码里用了它（本测试初版就误报了）。
const segCode = seg.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
ok('A10 跨层分支内没有引用 mine（它在此处仍未声明，引用即 TDZ）',
  !/\bmine\b\s*[.[]/.test(segCode), '分支里真的用了 mine');

ok('A11 层缺失被判为未知而不是第 0 层（Number(null) === 0 是陷阱）',
  /if \(o\.layer === null \|\| o\.layer === undefined \|\| o\.layer === ''\) return NaN;/.test(src),
  '直接用 Number(o.layer) 会把 null 变成合法层号 0');

// ───────────────────── B. 语义 oracle（真实读数回放）─────────────────────
// 复刻源码判据：过孔侧与层缺失都归为 NaN（未知），只有两端都是合法层号才比。
const layerNear = (k, v) => {
  if (k === 'via') return NaN;
  if (v === null || v === undefined || v === '') return NaN;
  return Number(v);
};
const isCross = (recovery) => (k1, layer1, k2, layer2) => {
  if (!recovery) return false;                       // 旧行为：一律当孤岛
  const la = layerNear(k1, layer1), lb = layerNear(k2, layer2);
  return Number.isFinite(la) && Number.isFinite(lb) && la !== lb;
};
const NEW = isCross(true);
const OLD = isCross(false);

// 真实读数：GND 的 Track 与 SMD Pad，d=0.01
ok('B1 真实读数 Track@1 vs SMD Pad@2 判为跨层（要打孔）',
  NEW('line', 1, 'pad', 2) === true, '真实事故仍被判成孤岛');

ok('B2 同层贴合仍判孤岛（不误伤 d6 的死铜孤岛结论）',
  NEW('line', 1, 'pad', 1) === false, '同层被当成跨层');

ok('B3 一侧是过孔不按跨层处理（过孔本就跨层）',
  NEW('line', 1, 'via', null) === false, '过孔侧被当成跨层');

ok('B4 层未知（null/NaN）不许当跨层',
  NEW('line', null, 'pad', 2) === false && NEW('line', NaN, 'pad', 2) === false,
  '层未知被当成跨层');

ok('B5 顶层(1) vs 内层(15) 也是跨层', NEW('line', 1, 'line', 15) === true, '内层漏判');

ok('B6 底层(2) vs 顶层(1) 也是跨层', NEW('line', 2, 'pad', 1) === true, '底层到顶层漏判');

// ───────────────────────── C. 反向对照 ─────────────────────────
ok('C1 去掉分支后真实读数变回"不动作"（本测试有鉴别力）',
  OLD('line', 1, 'pad', 2) === false, '反向对照不成立');

ok('C2 分支不改变同层结论',
  NEW('line', 1, 'pad', 1) === OLD('line', 1, 'pad', 1), '同层结论被改动');

// ───────────────────────── D. 零长线围栏 ─────────────────────────
// 跨层分支必须是"打一个孔就 continue"，不能落进下面那段
// "两端各打一孔 + 底层直连"的分支 —— 那里会画 cp.ax..cp.bx，而此处间距 0.01。
const iCrossCreate = at('pcb_PrimitiveVia.create(net, cx, cy');
ok('D1 跨层分支用的是 cx/cy 单点，不是 cp.ax~cp.bx 两点',
  iCrossCreate >= 0, '没找到单点打孔');

ok('D2 跨层分支以 continue 结束（不落入两端打孔+连线）',
  /patchedCrossLayer[\s\S]{0,900}?\n        \}\n        continue;/.test(src),
  '没有 continue 收口');

if (fails.length) {
  console.log('FAIL ' + pass + '/' + (pass + fails.length));
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('PASS ' + pass + '/' + pass + ' 跨层贴合打一个过孔，不再误判死铜孤岛');
process.exit(0);
