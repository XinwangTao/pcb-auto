// _test-holepair.js —— 锁住「Hole × Hole 必须有处理者」这条判据。
//
// 背景（真实事故，2026-11-26 00:21，USBC_Power_ESD / expand-1.25x）：
//   末次 DRC 只剩 4 条叶子：`Slot Region to Track`×2 + `Hole to Hole`×2，
//   而两轮 clearanceRound 都报 fixed=2/2、违规 4→4 一格没降。
//   病根不是修不动：Via 环要求 `obj*Type` 含 'Via'、Track 环要求含 'Track'，
//   而 DRC 给的是 `Hole`/`Hole` ⇒ **两个环都 continue**，这类违规从来没有处理者。
//   out\_d12-holepairs.md 量化过：两条都在流水线自己打的 GND 过孔与 J1 壳体
//   槽孔之间，cur=11.701 / need=11.811，只差 0.11 mil，把过孔推开 1 mil 即过。
//
// 本测试守五件事：
//   A. 结构：处理者存在、恰好只认 Hole×Hole、在 Via 环之前、位移不碰线端点；
//   B. 单位：minDistance / clearance 都是画布单位（mil/10），×10 才是 mil，
//      且**缺失必须先判 NaN**（Number(null)===0 会把"没读到"算成"缺口 11.8"）；
//   C. 语义 oracle：用 d12 的真实读数回放"该推多远 / 该不该放弃"；
//   D. 返回值：modify 失败是 resolve(undefined)，绝不能 `try/catch` 了事；
//   E. 可逆：回滚必须用 modify 推回旧坐标（不是 create 一个新孔）。
//
// ★ 所有 A/B/D/E 断言都 gate 在 A1（处理者存在）之上：否则在"根本没有这段代码"
//   的旧版本上，`!/holePair.../` 这类否定断言会**真空为真**，反向对照测不出东西。
//
// 用法: node _test-holepair.js [pipeline3.js 路径]
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

// ---- A1 先立：没有处理者，后面全部不成立 ----
const HP = "e.obj1Type === 'Hole' && e.obj2Type === 'Hole'";
const H = has(HP);
ok('A1 存在 Hole×Hole 过滤', H);
// gate：处理者不存在时，本组一律记为失败（不许真空为真）
const gate = (name, cond, detail) => ok(name, H && cond, H ? detail : '处理者不存在');

gate('A2 过滤变量叫 holePairs', has('const holePairs = clears.filter'));
gate('A3 处理者在 Via 环之前', (() => {
  const a = at(HP);
  const b = at("ed.obj2Type === 'Via' ? ed.obj2 : (ed.obj1Type === 'Via' ? ed.obj1 : null)");
  return a > 0 && b > 0 && a < b;
})());
gate('A4 位移不碰线端点（>6mil 才需要改线，这里不改）',
  !/holePair[\s\S]{0,1200}pcb_PrimitiveLine\.modify/.test(src));
gate('A5 位移封顶 6 mil', has('const delta = Math.min(6'));
gate('A6 超界要留痕、不能静默跳过', has("log('holePairTooFar'"));
gate('A7 找不到对象与"修不动"必须分开记账', has("log('holePairNoVia'"));
gate('A8 过孔索引每轮只建一次', has('const loadVias = async () => {'));
gate('A9 读数缺失单独一格，不外推成无望', has("log('holePairNoCoord'"));

// ---- B. 单位 ----
gate('B1 clearance 走 holeNumMil ×10', has('const needDist = holeNumMil(e.clearance);'));
gate('B2 minDistance 走 holeNumMil ×10', has('const curDist = holeNumMil(e.minDistance);'));
gate('B3 缺失先判 NaN 再 Number（Number(null)===0 陷阱）',
  /if \(v === null \|\| v === undefined \|\| v === ''\) return NaN;/.test(src));
gate('B4 holeNumMil 里真的 ×10',
  /holeNumMil[\s\S]{0,420}return Number\.isFinite\(n\) \? n \* 10 : NaN;/.test(src));
gate('B5 缺口 = need - cur', has('const deficit = needDist - curDist;'));

// ---- D. 返回值 ----
gate('D1 modify 返回 undefined 要单独记账', has("if (mr === undefined) { log('holePairModifyFail'"));
gate('D2 成功才计数', /if \(mr === undefined\)[\s\S]{0,600}holePairFixed\+\+/.test(src));

// ---- E. 可逆 ----
gate('E1 recMod 记下旧坐标', has("recMod(g.id, { kind: 'viaMoved', x: ox, y: oy, to: [nx, ny] })"));
gate('E2 回滚分支存在', has("if (m.kind === 'viaMoved') {"));
gate('E3 回滚用 modify 推回旧坐标', (() => {
  const i = at("if (m.kind === 'viaMoved') {");
  if (i < 0) return false;
  return src.slice(i, i + 900).indexOf('pcb_PrimitiveVia.modify(m.id, { x: bx, y: by })') >= 0;
})());
gate('E4 回滚分支不得出现 create', (() => {
  const i = at("if (m.kind === 'viaMoved') {");
  if (i < 0) return false;
  const j = src.indexOf("if (m.kind === 'viaDeleted') {", i);
  if (j < 0) return false;
  return src.slice(i, j).indexOf('pcb_PrimitiveVia.create') < 0;
})());
gate('E5 旧坐标缺失记 viaUnrestorable', (() => {
  const i = at("if (m.kind === 'viaMoved') {");
  if (i < 0) return false;
  return src.slice(i, i + 900).indexOf('viaUnrestorable.push') >= 0;
})());

// ---- C. 语义 oracle：用真实读数回放（与源码同构；改这里必须同时改源头）----
// holeNumMil 必须在 Number() 之前排除缺失：Number(null)===0 会把"没读到"
// 算成 "cur=0、缺口 11.8" ⇒ 记成 tooFar（近乎"无望"）。
const holeNumMil = (v) => {
  if (v === null || v === undefined || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n * 10 : NaN;
};
const decide = (curRaw, needRaw) => {
  const needDist = holeNumMil(needRaw);
  const curDist = holeNumMil(curRaw);
  if (!Number.isFinite(needDist) || !Number.isFinite(curDist)) return 'noCoord';
  const deficit = needDist - curDist;
  if (!(deficit > 0)) return 'odd';
  if (deficit + 1 > 6) return 'tooFar';
  return Math.min(6, Math.max(1, Math.ceil(deficit + 1)));
};
ok('C1 d12 真实读数 1.1701261/1.1811 → 推 2 mil',
  decide(1.1701261097518943, 1.1811) === 2, String(decide(1.1701261097518943, 1.1811)));
ok('C2 缺口 5.5 mil → tooFar（要改线端点，不做）',
  decide(0.63, 1.1811) === 'tooFar', String(decide(0.63, 1.1811)));
ok('C3 已经达标 → odd（不该被叫起来）',
  decide(1.19, 1.1811) === 'odd', String(decide(1.19, 1.1811)));
ok('C4 读数缺失 → noCoord，不是"无望"',
  decide(null, 1.1811) === 'noCoord', String(decide(null, 1.1811)));
ok('C5 空字符串也是缺失', decide('', 1.1811) === 'noCoord', String(decide('', 1.1811)));
ok('C6 推 2 mil 后余量 > 1 mil（d12 缺口 0.10977）', (2 - 0.10977) > 1);

if (fails.length) {
  console.log('FAIL ' + (fails.length) + '/' + (pass + fails.length));
  for (const f of fails) console.log('  × ' + f);
  process.exit(1);
}
console.log('PASS  ' + pass + '/' + pass + ' 通过  (Hole×Hole 有处理者：按缺口加大 1mil 推开过孔，可逆，超界即放弃)');
