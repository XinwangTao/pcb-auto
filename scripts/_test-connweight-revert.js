// _test-connweight-revert.js —— 锁住「间距违规和断路不是一种货币」这条判据。
//
// 真实事故（2026-11-26 01:24，gen-rp2040 / smart-fit，取片第 1 次）：
//   布线器已经跑完（routeState=completed，stillUnconnected=0），板子是连通的。
//   clearance 环为了修一处间距，删掉了一个 GND 过孔（viaDeleted {d:19.8, net:"GND"}）。
//   GND 因此断成 2 处断路 —— DRC 从 7 条 clearance 变成 0 条 clearance + 2 条
//   Connection Error。
//   回滚判据只问一句「clearance 条数有没有变多」。7 → 0，答"没有"，于是不回滚。
//   结果：一块连通的好板被改成了断路板，整轮判失败。
//   **总数下降不等于变好 —— 因为它把两种不可互换的代价加起来称。**
//
// 另外，就算判据对了，回滚也救不回来：旧代码把删掉的过孔记为 viaUnrestorable，
// 注释理由是"create 生成的是新 id，不算恢复"。那是对**账目**的要求，不是对**板子**
// 的要求。同坐标、同网、同孔径重画一个孔，电学上就是同一个孔。
//
// 守四件事：
//   A. 结构：断路单独计数、单独触发回滚；删孔前记全几何；回滚时把孔补回去
//   B. 语义 oracle：回放新判据，验证真实事故那一组读数会触发回滚
//   C. 反向：旧判据在真实事故读数上**必须**判"不回滚"（否则本测试空真）
//   D. 不许把"补不回来"和"补回来了"混成一个数
//
// 用法: node _test-connweight-revert.js [pipeline3.js 路径]
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
const at = (s) => src.indexOf(s);
const count = (s) => src.split(s).length - 1;

// ───────────────────────── A. 结构锁 ─────────────────────────
ok('A1 有独立的"上一轮断路数"状态', /let prevConnCount = null;/.test(src), '没找到 prevConnCount');

ok('A2 每轮从同一次 DRC 里数断路（不额外调用）',
  /const connsNow = flat\.filter\(v => v\.errorType === 'Connection Error'\)\.length;/.test(src),
  '没有 connsNow');

ok('A3 回滚判据同时看 clearance 与断路',
  /const connWorsened = prevConnCount !== null && connsNow > prevConnCount;/.test(src)
  && /if \(\(clearWorsened \|\| connWorsened\)/.test(src),
  '判据没纳入断路');

// 没有动过铜就没有可撤回的东西 —— 断路变多不等于"这一轮该回滚"
ok('A4 回滚仍要求本轮真的改过铜（无改动时撤回无意义）',
  /if \(\(clearWorsened \|\| connWorsened\) && \(roundMods\.length \|\| roundCreated\.length\)\) \{/.test(src),
  '丢了"本轮改过铜"这个前提');

ok('A5 回滚日志能看出是因为断路还是因为间距',
  /connFrom: prevConnCount, connTo: connsNow/.test(src) && /connWorsened\s*\n?\s*\?/.test(src),
  'rb 里没有断路前后读数/原因');

ok('A6 断路读数每轮推进（否则永远只比第一轮）',
  /prevClearCount = clears\.length;\s*\n\s*prevConnCount = connsNow;/.test(src),
  'prevConnCount 没推进');

// ---- 删孔前记全几何 ----
ok('A7 删孔前读出坐标（删完再读只能拿到 undefined）',
  /viaX = Number\(vv\.getState_X\?\.\(\)\);/.test(src)
  && src.indexOf('viaX = Number(vv.getState_X') < src.indexOf('const dv = await eda.pcb_PrimitiveVia.delete'),
  '坐标读取不在 delete 之前');

ok('A8 记录里带 x/y/viaType（少了就补不回去）',
  /kind: 'viaDeleted', net: netName\.trim\(\),\s*\n\s*x: viaX, y: viaY, viaType:/.test(src),
  'viaDeleted 记录缺几何');

ok('A9 读几何失败要留痕，不许静默退化成"补不回来"',
  at('viaGeomErr') >= 0, '没有 viaGeomErr');

// ---- 回滚时补孔 ----
// 按结构定位，不按注释文字定位：注释会改，分支结构不会。
const iRevertLoop = at('for (const m of roundMods.reverse())');
const iViaDelBranch = src.indexOf("if (m.kind === 'viaDeleted')", iRevertLoop);
const iPatchAnchor = src.indexOf('const patch = {};', iRevertLoop);
const viaDelSeg = (iViaDelBranch >= 0 && iPatchAnchor > iViaDelBranch)
  ? src.slice(iViaDelBranch, iPatchAnchor) : '';
ok('A10 回滚的 viaDeleted 分支里会重建过孔（不是只记一笔就算了）',
  iViaDelBranch > 0 && /eda\.pcb_PrimitiveVia\.create\(/.test(viaDelSeg),
  iViaDelBranch < 0 ? '回滚循环里没有 viaDeleted 分支' : '分支里没有 create');

ok('A11 重建用的是记录的原孔径与外径（不是默认值）',
  /Number\(b\.holeDiameter\), Number\(b\.diameter\)/.test(viaDelSeg),
  '重建没沿用原尺寸');

// ───────────────────── B. 语义 oracle（回放判据）─────────────────────
// 复刻源码决策：
//   clearWorsened = prevClear !== null && clear > prevClear
//   connWorsened  = prevConn  !== null && conn  > prevConn
//   revert        = (clearWorsened || connWorsened) && (mods || created)
const shouldRevert = (prev, now, changed) => {
  const clearWorsened = prev.clear !== null && now.clear > prev.clear;
  const connWorsened = prev.conn !== null && now.conn > prev.conn;
  return (clearWorsened || connWorsened) && changed > 0;
};
const shouldRevertOLD = (prev, now, changed) =>
  prev.clear !== null && now.clear > prev.clear && changed > 0;

// B1 真实事故那一组读数：7 条 clearance → 0 条，但多了 2 条断路
{
  const prev = { clear: 7, conn: 0 };
  const now = { clear: 0, conn: 2 };
  ok('B1 真实事故读数（7 间距 → 0 间距 + 2 断路）新判据必须回滚',
    shouldRevert(prev, now, 3) === true, JSON.stringify({ prev, now }));
}

// B2 反向：旧判据在**同一组读数**上必须判"不回滚"，否则 B1 空真
{
  const prev = { clear: 7, conn: 0 };
  const now = { clear: 0, conn: 2 };
  ok('B2 反向对照：旧判据在这组读数上判"不回滚"（说明事故真的发生过）',
    shouldRevertOLD(prev, now, 3) === false, '旧判据竟然也会回滚');
}

// B3 正常改善：间距变少、断路不变 ⇒ 不回滚（不许把好轮次也撤掉）
{
  ok('B3 间距 7→3、断路 0→0：不回滚（只该撤变差的）',
    shouldRevert({ clear: 7, conn: 0 }, { clear: 3, conn: 0 }, 5) === false, '');
}

// B4 间距没变、断路没变 ⇒ 不回滚
{
  ok('B4 两项都没变：不回滚',
    shouldRevert({ clear: 3, conn: 0 }, { clear: 3, conn: 0 }, 5) === false, '');
}

// B5 间距变多（旧判据也能抓）⇒ 仍要回滚，新增判据不许把它弄坏
{
  ok('B5 间距 1→4：仍回滚（原有能力不能被改坏）',
    shouldRevert({ clear: 1, conn: 0 }, { clear: 4, conn: 0 }, 2) === true, '');
}

// B6 断路变多但本轮没改过铜 ⇒ 不回滚（撤不回来，也不该撤）
{
  ok('B6 断路变多但本轮没动铜：不回滚（撤回救不了）',
    shouldRevert({ clear: 0, conn: 0 }, { clear: 0, conn: 3 }, 0) === false, '');
}

// B7 首轮（prev 全是 null）⇒ 不回滚，没有"上一轮"可比
{
  ok('B7 首轮没有上一轮读数：不回滚',
    shouldRevert({ clear: null, conn: null }, { clear: 9, conn: 9 }, 9) === false, '');
}

// ───────────────────────── C. 过孔重建 oracle ─────────────────────────
// 只有"坐标 + 孔径 + 外径都有正数"才可能补回来
const canRebuild = (m) => {
  const b = m && m.before ? m.before : {};
  return Number.isFinite(Number(m && m.x)) && Number.isFinite(Number(m && m.y))
    && (Number(b.diameter) > 0) && (Number(b.holeDiameter) > 0);
};
ok('C1 完整记录 → 可重建',
  canRebuild({ x: 1021.09, y: -1163.45, before: { holeDiameter: 11.8, diameter: 19.7 } }) === true, '');
ok('C2 缺坐标（旧格式记录）→ 判为补不回来，如实记账',
  canRebuild({ before: { holeDiameter: 11.8, diameter: 19.7 } }) === false, '');
ok('C3 尺寸为 0 / 缺失 → 判为补不回来（建不出合法孔）',
  canRebuild({ x: 1, y: 2, before: {} }) === false, '');
ok('C4 坐标是 NaN / undefined → 判为补不回来（不能盲建到原点）',
  canRebuild({ x: NaN, y: 2, before: { holeDiameter: 11.8, diameter: 19.7 } }) === false
  && canRebuild({ x: undefined, y: 2, before: { holeDiameter: 11.8, diameter: 19.7 } }) === false, '');

// ───────────────────────── D. 记账口径 ─────────────────────────
// 补回来的孔要计进 viaRestored（这样 fixedGivenBack 才会退掉那处记账），
// 补不回来的才进 viaUnrestorable。两者不能混。
ok('D1 补成功计入 viaRestored，不是 viaUnrestorable',
  /if \(!nid\) viaRestoreFail\.push\(m\.id\); else rb\.viaRestored\+\+;/.test(viaDelSeg),
  '重建成功没计数');

// 顺序即语义：几何不全 → 先记账退出；几何齐全才走 create。
// 反过来（先 create 再判断）会在坐标缺失时把孔建到原点。
ok('D2 几何检查在 create 之前，且只有不全才进 viaUnrestorable',
  viaDelSeg.indexOf('!(Number(b.diameter) > 0)') >= 0
  && viaDelSeg.indexOf('viaUnrestorable.push(m.id)') < viaDelSeg.indexOf('eda.pcb_PrimitiveVia.create('),
  'viaUnrestorable 与重建的顺序/条件不对');

// 这一处改动会改变板的最终状态，所以它**必须**进闸门（与截图那种只影响素材的不同）
ok('D3 clearanceRevertOk 仍然是闸门字段（这是板级判据，不是素材）',
  /clearanceRevertOk = \(restoreFail\.length \|\| delFail\.length\) \? false : true;/.test(src),
  'clearanceRevertOk 丢了');

if (fails.length) {
  console.log('FAIL ' + pass + '/' + (pass + fails.length));
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('PASS ' + pass + '/' + pass + ' 断路单独计数并触发回滚，删掉的过孔回滚时补回');
process.exit(0);
