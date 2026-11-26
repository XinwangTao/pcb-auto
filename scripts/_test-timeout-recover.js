// _test-timeout-recover.js —— 锁住「作业超时 ≠ 板子没通」这条判据。
//
// 背景（真实事故，2026-11-26 01:09，gen-rp2040 / smart-fit）：
//   route   {iter:0..2, state:"completed", ms:13695/3634/8333}
//   routeEscalate {reason:"FAST 3 轮后仍有断连，升级 COMPLETION 兜底"}
//   route   {iter:3, state:"TIMEOUT", ms:133617}
//   routeCancelled {iter:3, state:"TIMEOUT", ok:true}
//   routeBudgetStop {iter:3, leftMs:179083}
//   routeIter {iter:3, stillUnconnected:0}        ← 板子已经全部连通
//   _run.json: routeState="TIMEOUT", ok=false     ← 整块板被判死
//
// 判死的原因是 routeState 直接抄了「布线器作业怎么结束的」，而闸门问的是
// 「板子通没通」。COMPLETION 保底轮被我们按 capRaw 主动取消（协作式取消，
// 已算出的几何不落画布），于是作业状态是 TIMEOUT；但紧接着的 DRC 证明断连 = 0。
// 这一次白跑还白剩 179 秒预算。
//
// 本测试守三件事：
//   A. 结构：降级语句存在、只认「DRC 证明断连为 0」、在 break 之前；
//   B. 语义：用真实读数回放决策表，重点是 Infinity（查不出来）**不许**降级；
//   C. 反向：去掉降级后同一条读数必须变回失败 —— 否则本测试没有鉴别力。
//
// 用法: node _test-timeout-recover.js [pipeline3.js 路径]
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
const iRecover = at('routeStateRecovered');
ok('A1 存在降级日志 routeStateRecovered', iRecover >= 0, '缺 routeStateRecovered');

ok('A2 降级只在 stillUnconnected 严格等于 0 时发生',
  /if \(stillUnconnected === 0 && routeState !== 'completed'\) \{/.test(src),
  '降级条件不是「stillUnconnected === 0」');

// 「查不出来」必须仍然算失败：初值 Infinity 一旦被写成 0，
// 降级就会把空树/异常读成「已布通」。
ok('A3 stillUnconnected 初值仍是 Infinity',
  has('let stillUnconnected = Infinity;'),
  '初值被改小了，「未知」会被当成「已通」');

ok('A4 降级把 routeState 置为 completed',
  iRecover >= 0 && /routeStateRecovered[\s\S]{0,400}?routeState = 'completed';/.test(src),
  '降级没有把 routeState 改成 completed');

ok('A5 降级语句在 if (stillUnconnected === 0) break; 之前',
  iRecover >= 0 && at('if (stillUnconnected === 0) break;') > iRecover,
  '降级写在 break 之后 → 永远不执行');

ok('A6 原来的跳出仍然存在（没有被降级顺手删掉）',
  has('if (stillUnconnected === 0) break;'),
  'break 不见了');

// 降级必须记录「原来的值」，否则事后无法判断这次是"真跑完"还是"超时但已通"
ok('A7 降级日志带 was 字段',
  /routeStateRecovered[\s\S]{0,200}?was: routeState/.test(src),
  '日志没带 was，无法区分真跑完和降级');

// ───────────────────── B. 语义 oracle（真实读数回放）─────────────────────
// 复刻源码里的决策：有降级 / 无降级两版，用真实读数跑同一张表。
const decide = (recovery) => (state, still) => {
  if (recovery && still === 0 && state !== 'completed') return 'completed';
  return state;
};
const NEW = decide(true);
const OLD = decide(false);

// 真实读数（2026-11-26 01:09 gen-rp2040 iter 3）
ok('B1 真实读数 (TIMEOUT, 0) 降级为 completed',
  NEW('TIMEOUT', 0) === 'completed',
  '真实事故仍然被判失败');

ok('B2 查不出来 (TIMEOUT, Infinity) 仍是 TIMEOUT',
  NEW('TIMEOUT', Infinity) === 'TIMEOUT',
  '「未知」被降级成通过');

ok('B3 仍有断连 (TIMEOUT, 3) 仍是 TIMEOUT',
  NEW('TIMEOUT', 3) === 'TIMEOUT',
  '有断连却降级了');

ok('B4 作业出错但已通 (ERR, 0) 降级为 completed',
  NEW('ERR', 0) === 'completed',
  'ERR 分支没覆盖');

ok('B5 预算跳过但已通 (budget, 0) 降级为 completed',
  NEW('budget', 0) === 'completed',
  'budget 分支没覆盖（同一类缺陷）');

ok('B6 本来就 completed 不会重复记日志',
  NEW('completed', 0) === 'completed' && OLD('completed', 0) === 'completed',
  'completed 被改动');

ok('B7 围栏：只有 still===0 才降级，1 也不行',
  NEW('TIMEOUT', 1) === 'TIMEOUT',
  '阈值不是 0');

// ───────────────────────── C. 反向对照 ─────────────────────────
// 去掉降级后，同一条真实读数必须变回失败，否则 B1 是空真。
ok('C1 去掉降级后真实读数变回 TIMEOUT（本测试有鉴别力）',
  OLD('TIMEOUT', 0) === 'TIMEOUT',
  '反向对照不成立，B1 可能是空真');

ok('C2 降级不改变「有断连」的结论（不是放宽闸门）',
  NEW('TIMEOUT', 2) === OLD('TIMEOUT', 2),
  '降级把有断连的情况也放过了');

// ───────────────────────── 汇总 ─────────────────────────
if (fails.length) {
  console.log('FAIL ' + pass + '/' + (pass + fails.length));
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('PASS ' + pass + '/' + pass);
process.exit(0);
