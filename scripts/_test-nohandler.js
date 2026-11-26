// _test-nohandler.js —— 锁住「无处理者的违规类必须可见」。
//
// 缺陷：fixClearance 有两个独立循环，各自只认一侧 ——
//   Via 环处理「含 Via」的违规，Track 环处理「含 Track」的违规。
// 两侧都不是（Hole×Hole、Pad×Pad、Slot×Slot…）时**两个循环都静默 continue**。
// 后果：这类违规每轮原样被带过去，而 fixed 因为**别的**项在涨、clearanceRound 也
// 照常打印，日志读起来像"正在修"。
// 实测 d12（out\USBC_Power_ESD-20261126-002156\_log-2-expand-1.25x.json）：
//   末障碍 Hole×Hole(11.7066/11.811)，两轮 fixed=2/2，违规 4→4，一格没降。
//
// 「没有处理者」与「处理了但没用」是两种缺陷，必须能分开。
//
// 守四件事：
//   A. 结构：计数表 + 两个 noteNoHandler 调用点 + 轮末日志键都在；
//   B. 两个静默 continue 的旧形状必须消失（否则计数点根本走不到）；
//   C. 计数语义 oracle：同类累加、异类分开、缺类型归一成 '?'；
//   D. 无副作用：noteNoHandler 不得出现在任何 fixed++ 行上（先测量，不改行为）；
//      且反向对照（旧构建）必须红。
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

// ───────── A. 结构 ─────────
ok('A1 计数表声明在', has('const noHandler = new Map();'));
ok('A2 计数函数存在（带违规对象入参，用于去重）', has('const noteNoHandler = (v, t1, t2, why) => {'));
ok('A3 Via 环无 Via 侧时记账', has("if (!viaObjId) { noteNoHandler(v, ed.obj1Type, ed.obj2Type, '无 Via 侧'); continue; }"));
ok('A4 Track 环无 Track 侧时记账', has("if (!trackId) { noteNoHandler(v, ed.obj1Type, ed.obj2Type, '无 Track 侧'); continue; }"));
ok('A5 轮末日志键 clearanceNoHandler', has("log('clearanceNoHandler', {"));
ok('A6 日志分 uncovered/covered 两栏（不再把正常分工当无人处理）',
  /log\('clearanceNoHandler'[\s\S]{0,400}uncovered[\s\S]{0,200}covered/.test(src));
ok('A7 日志带 why（说清为什么无人认领）', /log\('clearanceNoHandler'[\s\S]{0,300}why:/.test(src));
ok('A8 只在非空时打日志（不制造空行噪音）',
  /if \(noHandler\.size\) \{[\s\S]{0,700}?log\('clearanceNoHandler'/.test(src));

// 声明必须早于两个使用点（否则 TDZ 崩，且崩在修复中途）
const iDecl = at('const noteNoHandler = (');
const iViaUse = at("noteNoHandler(v, ed.obj1Type, ed.obj2Type, '无 Via 侧')");
const iTrkUse = at("noteNoHandler(v, ed.obj1Type, ed.obj2Type, '无 Track 侧')");
const iLog = at("log('clearanceNoHandler'");
ok('A9 声明早于 Via 环使用点', iDecl > 0 && iDecl < iViaUse, iDecl + '/' + iViaUse);
ok('A10 声明早于 Track 环使用点', iDecl > 0 && iDecl < iTrkUse, iDecl + '/' + iTrkUse);
ok('A11 日志在声明之后（同一轮作用域内）', iLog > iDecl, iLog + '/' + iDecl);

// ───────── B. 旧静默形状必须消失 ─────────
ok('B1 旧 Via continue 形状已拆开', !has('if (!viaObjId || seenVia.has(viaObjId)) continue;'));
ok('B2 旧 Track continue 形状已拆开', !has('if (!trackId || seenVia.has(trackId)) continue;'));
ok('B3 dedup 语义仍保留（去重不能顺手删掉）', has('if (seenVia.has(viaObjId)) continue;') && has('if (seenVia.has(trackId)) continue;'));

// ───────── C. 计数语义 oracle（独立复刻，不引用被测代码） ─────────
// C 段旧版按"跳过次数"记账，那正是本轮的口径缺陷（一条违规会被两个环各跳一次、
// 于是 n=2）。这里改成按**违规对象**去重 + 分 uncovered/covered，与实现同口径，
// 但用独立复刻算一遍，防止实现与测试一起错。
const mk = () => {
  const m = new Map();
  const seen = new Set();
  return {
    note: (v, t1, t2, why) => {
      if (seen.has(v)) return;              // 同一条违规只记一次
      seen.add(v);
      const k = String(t1 || '?') + '×' + String(t2 || '?');
      const a = String(t1 || ''), b = String(t2 || '');
      const bucket = (!a || !b) ? 'covered'
        : (!(a === 'Via' || b === 'Via' || a === 'Track' || b === 'Track') ? 'uncovered' : 'covered');
      const rec = m.get(k) || { pair: k, n: 0, why, bucket };
      rec.n++; m.set(k, rec);
    },
    out: () => [...m.values()],
  };
};
{
  // 一条 SMD Pad×Hole：Via 环跳过、Track 环也跳过 —— 只能算 **1 条**违规
  const v1 = { id: 'v1' };
  const c = mk();
  c.note(v1, 'SMD Pad', 'Hole', '无 Via 侧');
  c.note(v1, 'SMD Pad', 'Hole', '无 Track 侧');
  const o = c.out();
  ok('C1 同一条违规被两个环各跳一次，只记 1（不按跳过次数记）',
    o.length === 1 && o[0].n === 1, JSON.stringify(o));
  ok('C2 两侧都不是 Via/Track ⇒ 归 uncovered', o[0].bucket === 'uncovered');
  ok('C3 why 取首次（不被后续覆盖成另一环的成因）', o[0].why === '无 Via 侧');
}
{
  // 一条 SMD Pad×Via：Via 环认领了它，Track 环只是"跳过"—— **不是**无人处理
  const c = mk();
  c.note({ id: 'v2' }, 'SMD Pad', 'Via', '无 Track 侧');
  const o = c.out();
  ok('C4 含 Via 的违规归 covered（另一环已认领，正常分工）',
    o.length === 1 && o[0].bucket === 'covered', JSON.stringify(o));
}
{
  // 两条不同的违规 ⇒ 2 条，不合并
  const c = mk();
  c.note({ id: 'a' }, 'Hole', 'Hole', '无 Via 侧');
  c.note({ id: 'b' }, 'SMD Pad', 'Hole', '无 Via 侧');
  const o = c.out();
  ok('C5 不同违规分开计（合计 2）', o.length === 2 && o.reduce((x, y) => x + y.n, 0) === 2,
    JSON.stringify(o));
}
{
  const c = mk();
  c.note({ id: 'n' }, null, undefined);
  const o = c.out();
  ok('C6 缺类型归一成 ?×?（不抛、不丢样本，且不冒认成 uncovered）',
    o.length === 1 && o[0].pair === '?×?' && o[0].bucket === 'covered', JSON.stringify(o));
}

// ───────── E. 全轮无人认领 ⇒ 提前退出（且不缺环） ─────────
ok('E1 先按类型分类出 unclaimable', has('const unclaimable = clears.filter((v) => {'));
ok('E2 分类判据只看类型（四路都不命中才算无人认领）；已抽成共享函数供两处复用',
  /const noSideIsViaOrTrack[\s\S]{0,400}?!== 'Via' && b !== 'Via' && a !== 'Track' && b !== 'Track'/.test(src));
ok('E3 全轮无人认领时提前退出', has('const allUnclaimable = unclaimable.length > 0 && unclaimable.length >= clears.length;'));
ok('E4 退出前打 clearanceAllUnclaimable', has("log('clearanceAllUnclaimable', {"));
const iRound = at("log('clearanceRound', { round, violations: clears.length, fixed });");
const iAllU = at("log('clearanceAllUnclaimable'");
const iBreak = src.indexOf('break;', iAllU);
ok('E5 clearanceRound 仍先于退出日志（时间序列不缺环）', iRound > 0 && iAllU > iRound, iRound + '/' + iAllU);
ok('E6 退出日志之后确实 break（不是只打日志继续烧轮次）', iAllU > 0 && iBreak > iAllU, iAllU + '/' + iBreak);
ok('E7 部分是无人认领时**不**早退（否则放弃可修项）',
  /if \(allUnclaimable\) \{/.test(src) && !/if \(unclaimable\.length\) \{[\s\S]{0,200}break;/.test(src));

// 分类 oracle：独立复刻判据，锁住"含 Via 不算无人认领"这类边界
{
  const unclaimableOf = (obj1Type, obj2Type) => {
    const t1 = String(obj1Type || ''), t2 = String(obj2Type || '');
    if (!t1 || !t2) return false;                 // 缺字段 = 可能有处理者，不外推
    return t1 !== 'Via' && t2 !== 'Via' && t1 !== 'Track' && t2 !== 'Track';
  };
  ok('E8 Hole×Hole 无人认领', unclaimableOf('Hole', 'Hole') === true);
  ok('E9 Pad×Pad 无人认领', unclaimableOf('SMD Pad', 'SMD Pad') === true);
  ok('E10 Track×Hole 有 Track 环认领', unclaimableOf('Track', 'Hole') === false);
  ok('E11 Hole×Via 有 Via 环认领', unclaimableOf('Hole', 'Via') === false);
  ok('E12 Track×Via 两个环都认领', unclaimableOf('Track', 'Via') === false);
  // 缺字段只能证明"我看不出谁来处理"，不能证明"没人会处理"。
  // 把"不知道"当"没人管"会据一句猜测早退，白扔真正可修的违规 ——
  // 与「未复核 ≠ 通过」同一类错误，只是方向相反。
  ok('E13 类型缺失时不冒认（不外推成无人认领）', unclaimableOf(null, undefined) === false);
  // E14 曾断言 `if (!t1 || !t2) return false;` 字面出现在 unclaimable 里。
  // 后来判据被抽成 noSideIsViaOrTrack 供两处复用 —— 断言锁"某段字面在哪一行"
  // 会随重构误报。改为锁**语义**：那个守卫必须存在于共享判据里，且缺字段返 false。
  ok('E14 共享判据里缺字段确实早返回 false',
    /const noSideIsViaOrTrack[\s\S]{0,400}?if \(![^)]*\) return false;/.test(src),
    'noSideIsViaOrTrack 里找不到缺字段守卫');
  ok('E15 unclaimable 复用共享判据（不另写一份）',
    /const unclaimable = clears\.filter\([\s\S]{0,300}?noSideIsViaOrTrack\(/.test(src));
}

// ───────── D. 无副作用 + 反向对照 ─────────
const badLines = src.split('\n').filter(l => l.indexOf('noteNoHandler') >= 0 && l.indexOf('fixed++') >= 0);
ok('D1 noteNoHandler 不出现在 fixed++ 行（纯观测，不改修复行为）', badLines.length === 0, JSON.stringify(badLines));
ok('D2 两个旧 continue 形状确实已被替换（旧构建必红）',
  !has('if (!viaObjId || seenVia.has(viaObjId)) continue;') &&
  !has('if (!trackId || seenVia.has(trackId)) continue;'));

if (fails.length) {
  console.error('FAIL  ' + pass + '/' + (pass + fails.length) + ' 通过');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('PASS  ' + pass + '/' + pass + ' 通过  (无处理者的违规类现在会落 clearanceNoHandler)');
process.exit(0);
