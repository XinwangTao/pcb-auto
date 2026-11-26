// _test-stats-coverage.js —— 锁住「统计表的键集合必须自洽」。
//
// 缺陷（反复出现，已三次）：
//   _drcstats.js 用 `if (s in counts) counts[s]++` 累加，而 `counts` 是**手写**的格子表。
//   pipeline3.js 新增一个失败/放弃事件、把它登记进 FIX_EVENTS，却忘了在 counts 里开格子，
//   于是这个事件**永远累加不到**，报告里表现成「0 次」。
//   而「0 次」与「根本没统计」在输出上完全同形 —— 这正是本项目反复踩的那类坑。
//
// 实测（2026-11-26 检查）：FIX_EVENTS 里 6 个键没有格子，全是"最近才加的"：
//   clearanceNoProgress、pourMeasured、pourRebuildEmpty、
//   pourMeasureErr、pourRebuildErr、pourFail
// 也就是说「覆铜重建到底成功了几次」这一整列，一直恒为 0。
//
// 守三件事：
//   A  FIX_EVENTS 里的每个键都必须在 counts 里有格子（否则永不累加）；
//   B  pipeline3.js 里「疑似失败/放弃」的 log 键必须登记进统计，
//      且登记后同样要有格子 —— 否则新增的观测点等于没加；
//   C  反向对照：把一个已知漏键喂进去，A 段必须红（证明判据可证伪）。
'use strict';
const fs = require('fs');
const path = require('path');

const STATS = process.argv[2] || path.join(__dirname, '_drcstats.js');
const PIPE = process.argv[3] || path.join(__dirname, 'pipeline3.js');

let stats, pipe;
try { stats = fs.readFileSync(STATS, 'utf8'); } catch (e) { console.error('读不到 ' + STATS); process.exit(2); }
try { pipe = fs.readFileSync(PIPE, 'utf8'); } catch (e) { console.error('读不到 ' + PIPE); process.exit(2); }

let pass = 0;
const fails = [];
const ok = (n, c, d) => { if (c) pass++; else fails.push(n + (d ? '  << ' + d : '')); };

// ---- 解析出两个集合（独立复刻，不引用被检查的逻辑）----
function setOf(src, re) {
  const m = src.match(re);
  if (!m) return null;
  return new Set([...m[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map(x => x[1]));
}
const fixEvents = setOf(stats, /const FIX_EVENTS = new Set\(\[([\s\S]*?)\]\);/);
ok('P1 能解析到 FIX_EVENTS（解析失败时下面全部无意义）', !!fixEvents);
if (!fixEvents) { console.error('FAIL 0/1: 解析不到 FIX_EVENTS'); process.exit(1); }

const countsBlock = stats.match(/const counts = \{([\s\S]*?)\n\s*\};/);
ok('P2 能解析到 counts 对象', !!countsBlock);
if (!countsBlock) { console.error('FAIL 0/2: 解析不到 counts'); process.exit(1); }
const countsKeys = new Set([...countsBlock[1].matchAll(/([A-Za-z0-9_]+)\s*:\s*0/g)].map(x => x[1]));

// pipeline3.js 里所有 log 键
const pipeKeys = new Set([...pipe.matchAll(/log\('([A-Za-z0-9_]+)'/g)].map(m => m[1]));
ok('P3 pipeline3.js 里能读到 log 键（样本非空）', pipeKeys.size > 100, 'n=' + pipeKeys.size);

// ---- A. FIX_EVENTS ⊆ counts ----
const missing = [...fixEvents].filter(k => !countsKeys.has(k)).sort();
ok('A1 FIX_EVENTS 每个键在 counts 里都有格子',
  missing.length === 0, '缺 ' + missing.length + ' 个: ' + missing.join(', '));

// ---- B. 失败/放弃类 log 键必须能统计到 ----
// 命名判据：这些词根都表示"这件事没做成"。它们必须**在 counts 里有格子**，
// 否则 `if (s in counts)` 不成立、一次都不累加，"这次没发生"与"我们没在数"分不开。
// 注意：进不进 FIX_EVENTS 是另一件事 —— 那决定它是否归属到某一轮的动作列，
// 不影响能不能计数。把两件事混在一起会让这条判据又变回"只查非零"。
const SUSPECT = /Skip|Fail|Err|Unconfirmed|Rolled|Revert|GivenUp|NoProgress|Empty|Negative|Hopeless|Degenerate|TooShort|Unparsed|Unrestorable|Rollback/;
const suspects = [...pipeKeys].filter(k => SUSPECT.test(k)).sort();
ok('B0 判据命中了合理数量的键（判据失效会命中 0 或全部）',
  suspects.length >= 20 && suspects.length < pipeKeys.size, 'n=' + suspects.length);
const uncounted = suspects.filter(k => !countsKeys.has(k));
ok('B1 所有失败/放弃类键在 counts 里都有格子',
  uncounted.length === 0,
  '缺格 ' + uncounted.length + ' 个: ' + uncounted.join(', '));

// ---- C. 反向对照：判据必须能抓到"漏格子"这个形状 ----
// 造一个假的 stats 文本：FIX_EVENTS 里有 fooBar，counts 里没有。
{
  const fake = "const FIX_EVENTS = new Set(['fooBar', 'trackThinned']);\n"
    + 'const counts = {\n    trackThinned: 0\n  };\n';
  const f = setOf(fake, /const FIX_EVENTS = new Set\(\[([\s\S]*?)\]\);/);
  const cb = fake.match(/const counts = \{([\s\S]*?)\n\s*\};/);
  const ck = new Set([...(cb ? cb[1] : '').matchAll(/([A-Za-z0-9_]+)\s*:\s*0/g)].map(x => x[1]));
  const fakeMissing = [...f].filter(k => !ck.has(k));
  ok('C1 判据能抓到只在 FIX_EVENTS 里的键', fakeMissing.length === 1 && fakeMissing[0] === 'fooBar',
    JSON.stringify(fakeMissing));
}

if (fails.length) {
  console.error('FAIL  ' + pass + '/' + (pass + fails.length) + ' 通过');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('PASS  ' + pass + '/' + pass + ' 通过  (统计表的键集合自洽：登记即开格，'
  + countsKeys.size + ' 格 / FIX_EVENTS ' + fixEvents.size + ' 键 / log 键 ' + pipeKeys.size
  + ' 个不漏)');
process.exit(0);
