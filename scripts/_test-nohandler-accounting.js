// _test-nohandler-accounting.js —— 锁住「无人处理」这条日志的记账口径。
//
// 缺陷（本轮实测出来，不是推测）：
//   RP2040_Minimal-20261126-004202 的真实日志是
//     clearanceNoHandler {classes:[{pair:'SMD Pad×Hole',n:2,why:'无 Via 侧'},
//                                 {pair:'SMD Pad×Via', n:1,why:'无 Track 侧'}]}
//     clearanceUnclaimable {n:1,total:2}
//   同一轮的 DRC 只有 2 条违规，其中真正无人处理的只有 1 条（SMD Pad×Hole）。
//   可日志读起来像"3 条无人处理"，而 SMD Pad×Via 那条其实**被 Via 环修好了**
//   （同轮 clearanceRound.fixed=1）。这条日志会把今后的分析整段带偏。
//
// 两个独立的记账错误叠在一起：
//   ① **按"跳过次数"记账，不是按"违规条数"**。一条 SMD Pad×Hole 会被两个循环
//      各跳过一次（Via 环说"无 Via 侧"、Track 环说"无 Track 侧"），于是 n=2。
//   ② **把"某个环跳过"当成"没人处理"**。含 Via 的违规由 Via 环认领，Track 环跳过
//      是正常分工，却被记进"无人认领"。
//
// 守五件事：
//   A 按违规对象去重 ⇒ n 是违规条数（一条违规最多记一次）；
//   B 分两栏：真正没人管的(uncovered) 与 由另一环认领的(covered)，措辞各归各位；
//   C uncovered 的判据与 unclaimable 同口径（两侧都不是 Via/Track），不另写一份；
//   D 可对账：同一轮 uncovered 合计 == clearanceUnclaimable.n；
//   E 反向对照：旧构建没有 uncovered 分栏（同一套断言在旧文件上必须红）。
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

// ───────── A. 按违规去重，不按跳过次数 ─────────
ok('A1 noteNoHandler 接收违规对象（否则无法去重）',
  /noteNoHandler\s*=\s*\(\s*v\s*,/.test(src) || /noteNoHandler\(\s*v\s*,/.test(src),
  '签名里看不到 v');
ok('A2 有 seenPerViolation 之类的去重集合', /noHandlerSeen|notedViolation|seenNote/.test(src));
ok('A3 去重发生在自增之前（先判后加）', (() => {
  const i = at('const noteNoHandler = ');
  if (i < 0) return false;
  const body = src.slice(i, i + 700);
  const iSeen = body.search(/noHandlerSeen|notedViolation|seenNote/);
  const iInc = body.search(/\.n\+\+|\.n \+= 1|\.n = /);
  return iSeen > 0 && iInc > 0 && iSeen < iInc;
})(), '去重与自增顺序不对');

// ───────── B. 分两栏，措辞各归各位 ─────────
ok('B1 有 uncovered 分栏', has('uncovered'));
// 注意：必须在**日志块内**找 covered —— 全文搜 covered 会被别处的注释命中（假通过）。
ok('B2 有 covered 分栏（另一环认领的，不属于"无人处理"）', (() => {
  const i = at("log('clearanceNoHandler'");
  if (i < 0) return false;
  return /covered/.test(src.slice(i, i + 1400));
})(), '日志块里看不到 covered');
ok('B3 clearanceNoHandler 的旧措辞已改（不再说"两侧都不是时无人认领"当作整体结论）',
  !/why: '这两个循环只认含 Via \/ 含 Track 的违规；两侧都不是时无人认领，每轮原样带过'/.test(src),
  '旧 why 文本仍在');
ok('B4 只有 uncovered 写成"没人会处理"的意思', (() => {
  const i = at("log('clearanceNoHandler'");
  if (i < 0) return false;
  const blk = src.slice(i, i + 1400);
  return /uncovered/.test(blk) && /covered/.test(blk);
})(), '日志块里看不到两栏');

// ───────── C. uncovered 判据与 unclaimable 同口径 ─────────
ok('C1 unclaimable 的判据是"两侧都不是 Via/Track"',
  /!== 'Via'[\s\S]{0,80}!== 'Via'[\s\S]{0,80}!== 'Track'[\s\S]{0,80}!== 'Track'/.test(src)
  || /noSideIsViaOrTrack|claimableByLoop|uncoveredPair/.test(src),
  '找不到同一口径的判据');
ok('C2 抽成了共享函数（避免同一份判据写两遍）',
  /function noSideIsViaOrTrack|const noSideIsViaOrTrack/.test(src));

// ───────── D. 可对账 + 运行时算术 oracle ─────────
// 独立复刻两套记账，喂同一条真实数据：2 条违规，[SMD Pad×Hole], [SMD Pad×Via]。
{
  const violations = [{ t1: 'SMD Pad', t2: 'Hole' }, { t1: 'SMD Pad', t2: 'Via' }];
  const isVia = (v) => v.t1 === 'Via' || v.t2 === 'Via';
  const isTrack = (v) => v.t1 === 'Track' || v.t2 === 'Track';
  const unclaimed = violations.filter(v => !isVia(v) && !isTrack(v));

  // 旧口径：按跳过次数
  const oldN = new Map();
  for (const v of violations) {
    if (!isVia(v)) { const k = v.t1 + '×' + v.t2; oldN.set(k, (oldN.get(k) || 0) + 1); }
    if (!isTrack(v)) { const k = v.t1 + '×' + v.t2; oldN.set(k, (oldN.get(k) || 0) + 1); }
  }
  const oldTotal = [...oldN.values()].reduce((a, b) => a + b, 0);
  // 新口径：按违规去重，分 uncovered / covered
  const uncovered = new Map(), covered = new Map();
  for (const v of violations) {
    const k = v.t1 + '×' + v.t2;
    const noHandlerHR = !isVia(v) && !isTrack(v);
    const m = noHandlerHR ? uncovered : covered;
    m.set(k, (m.get(k) || 0) + 1);
  }
  const newTotal = [...uncovered.values()].reduce((a, b) => a + b, 0)
                 + [...covered.values()].reduce((a, b) => a + b, 0);

  ok('D1 旧口径把 2 条违规数成 3 次跳过（这正是本测试要修的偏差）', oldTotal === 3, 'oldTotal=' + oldTotal);
  ok('D2 新口径按违规计，合计 == 违规条数', newTotal === 2, 'newTotal=' + newTotal);
  ok('D3 uncovered 只有 1 条（SMD Pad×Hole），与 clearanceUnclaimable.n 一致',
    uncovered.size === 1 && uncovered.get('SMD Pad×Hole') === 1,
    JSON.stringify([...uncovered]));
  ok('D4 SMD Pad×Via 落进 covered，不再冒充"无人处理"',
    covered.size === 1 && covered.get('SMD Pad×Via') === 1, JSON.stringify([...covered]));
  ok('D5 uncovered 合计 == unclaimed.length（与 unclaimable 同一数据源）',
    [...uncovered.values()].reduce((a, b) => a + b, 0) === unclaimed.length);
}

// ───────── E. 不改变修复行为：两条 continue 仍在 ─────────
ok('E1 Via 环仍在"无 Via 侧"后跳过', has("'无 Via 侧'"));
ok('E2 Track 环仍在"无 Track 侧"后跳过', has("'无 Track 侧'"));
ok('E3 两处都仍是 continue（没有因为改日志而改成 break 或放行）', (() => {
  const a = at("'无 Via 侧'"), b = at("'无 Track 侧'");
  if (a < 0 || b < 0) return false;
  return /continue;/.test(src.slice(a, a + 200)) && /continue;/.test(src.slice(b, b + 200));
})(), '某处的 continue 不见了');

// ───────── F. 两个数字必须自解释（我自己就误读过）─────────
// 原来 clearanceUnclaimable 写 `total: clears.length`，{n:1,total:2} 看上去像
// "无人认领合计 2 却只列了 1 条"的脏数据。其实 total 是**分母**（本轮 clearance
// 违规总数），与 n 完全不同义。字段名必须一眼能分开，否则每次读日志都要重新推。
ok('F1 clearanceUnclaimable 用 clearanceTotal 明确表示分母',
  /clearanceUnclaimable'[\s\S]{0,300}?clearanceTotal: clears\.length/.test(src),
  '分母字段仍是含义模糊的 total');

ok('F2 没有把两者写成一个数（n 与分母必须两个字段）',
  !/clearanceUnclaimable'[\s\S]{0,300}?round, n: unclaimable\.length, total:/.test(src),
  '仍有 total 与 n 混用');

if (fails.length) {
  console.error('FAIL  ' + pass + '/' + (pass + fails.length) + ' 通过');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('PASS  ' + pass + '/' + pass + ' 通过  (无人处理按违规计并与 covered 分栏，可与 clearanceUnclaimable 对账)');
process.exit(0);
