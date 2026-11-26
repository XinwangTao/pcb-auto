// _test-skip-log.js —— 锁住「兜底路径上的放弃必须留痕」。
//
// 缺陷：Track 侧处理一处间距违规的正确顺序是
//   缩窄 → （不够）走廊绕行 → （找不到走廊）端点保持的兜底平移。
// 兜底平移内部有 3 处直接 `continue`：
//   · 线段起点终点几乎重合（L 形与平移都会造出零长/叠合线段）
//   · DRC 没给出可用违规坐标
//   · 线段比 push*4 还短（平移会扯断两端焊盘）
// 旧实现三处全静默 —— 于是日志里
//   「处理者存在但无力处理」与「这处根本没被看到」长得一模一样。
// 而 11 处裸空 catch 的历史教训正是「没记录 ≠ 没发生」。
//
// 守四件事：
//   A 三处都换成了「记账 + continue」，旧的一行式静默形状必须消失；
//   B 顺序：记录在前、continue 在后（否则永远执行不到）；
//   C 载荷足够定位：line / 原因字段 / why；
//   D 三个 key 彼此不同（合成一个就再也分不清是哪条路走不通）。
'use strict';
const fs = require('fs');
const path = require('path');

const TARGET = process.argv[2] || path.join(__dirname, 'pipeline3.js');
let src;
try { src = fs.readFileSync(TARGET, 'utf8'); }
catch (e) { console.error('读不到 ' + TARGET + ' : ' + e.message); process.exit(2); }

let pass = 0;
const fails = [];
const ok = (n, c, d) => { if (c) pass++; else fails.push(n + (d ? '  << ' + d : '')); };
const has = (s) => src.indexOf(s) >= 0;
const at = (s) => src.indexOf(s);
const cnt = (re) => (src.match(re) || []).length;

// ───────── A. 三个 key 存在，旧的静默形状消失 ─────────
const KEYS = [
  ['clearanceSkipDegenerate', 'if (!(len > 1)) continue;'],
  ['clearanceSkipNoPos', 'if (!Number.isFinite(violX) || !Number.isFinite(violY)) continue;'],
  ['clearanceSkipTooShort', 'if (len < push * 4) continue;'],
];
for (const [key, oldShape] of KEYS) {
  ok('A ' + key + ' 恰好出现一次', cnt(new RegExp("log\\('" + key + "'", 'g')) === 1,
    'x' + cnt(new RegExp("log\\('" + key + "'", 'g')));
  ok('A ' + key + ' 的旧静默形状已消失', !has(oldShape), '仍存在: ' + oldShape);
}

// ───────── B. 记录必须在 continue 之前 ─────────
// 只检查"log 在 continue 之前"是不够的：要确认它在**同一个 if 块**里，
// 否则把 log 挪到 if 外面也能过，而那等于每次都记（噪音）。
for (const [key] of KEYS) {
  const re = new RegExp("\\{[^{}]*?log\\('" + key + "'[\\s\\S]{0,700}?continue;\\s*\\}", '');
  ok('B ' + key + ' 的记录与 continue 在同一块内、且记录在前', re.test(src));
}

// ───────── C. 载荷能定位到具体对象 ─────────
for (const [key] of KEYS) {
  const i = at("log('" + key + "'");
  ok('C ' + key + ' 带 line（哪条线）', i > 0 && src.slice(i, i + 320).indexOf('line: trackId') >= 0);
  ok('C ' + key + ' 带 why（为什么放弃）', i > 0 && src.slice(i, i + 900).indexOf('why:') >= 0);
}
// 三处都应该带 net，便于按网络聚合
ok('C 三处都带 net', cnt(/clearanceSkip(?:Degenerate|NoPos|TooShort)'[\s\S]{0,200}?net:/g) >= 3,
  String(cnt(/clearanceSkip(?:Degenerate|NoPos|TooShort)'[\s\S]{0,200}?net:/g)));

// ───────── D. 三个 key 互不相同的语义 + 都在兜底分支内 ─────────
ok('D 三个 key 各不相同', new Set(KEYS.map(k => k[0])).size === 3);
{
  const iChosen = at('if (!chosen) {');
  const iDeg = at("log('clearanceSkipDegenerate'");
  const iPos = at("log('clearanceSkipNoPos'");
  const iShort = at("log('clearanceSkipTooShort'");
  ok('D 三处都在「找不到走廊」的兜底分支之内（否则会误报正常路径）',
    iChosen > 0 && iDeg > iChosen && iPos > iChosen && iShort > iChosen,
    [iChosen, iDeg, iPos, iShort].join('/'));
  ok('D 三处顺序与原代码一致（退化 → 无坐标 → 太短）',
    iDeg > 0 && iPos > iDeg && iShort > iPos, [iDeg, iPos, iShort].join('/'));
}

// ───────── E. 不给"已被别的键覆盖"的路径重复记账 ─────────
// 这三点都不该走 viaKept / viaFixErr / trackThinned 之类，必须是新键。
for (const [key] of KEYS) {
  ok('E ' + key + ' 不与已有修复键同名',
    !/clearanceFixes'/.test(key) && !/trackThinned|viaKept|viaShrunk/.test(key));
}

if (fails.length) {
  console.error('FAIL  ' + pass + '/' + (pass + fails.length) + ' 通过');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('PASS  ' + pass + '/' + pass + ' 通过  (兜底路径的三处放弃都留痕，不再与"没看到"同形)');
process.exit(0);
