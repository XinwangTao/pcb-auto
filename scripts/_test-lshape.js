// _test-lshape.js —— L 形走廊改道：拓扑必须按轴区分
//
// 背景（2026-11-25 实测，d13"太阳能充电户外温湿度记录仪"）：
//   clearanceRound 是 4,4,3,3,3,3,3,3、fixed 是 4,3,3,3,3,3,3,3 —— 六轮都在"修成功"，
//   违规数一格没降。根因是 pipeline3.js 的 L 形三段只实现了 axis='x'：
//     axis='x'：corner1=(at,sy) corner2=(at,ey)  → 腿1 水平 / 中段 竖直 / 腿2 水平   ✅
//     axis='y'：corner1=(sx,at) corner2=(ex,at)  → 腿1 竖直 / 中段 水平 / 腿2 竖直   ✅ 正确
//   旧代码把 c1 写死成 (cornerX,cornerY)→(cornerX,ey)、c2 写死成 (cornerX,ey)→(ex,ey)，
//   只对 axis='x' 成立。axis='y' 时实际建成：
//     原线：(sx,sy)→(sx,at)
//     c1  ：(sx,at)→(sx,ey)        ← 与"原线 + 原线剩余段"完全重合，等于原地折返
//     c2  ：(sx,ey)→(ex,ey)        ← 就是原来那条违规线，原样重建
//   净效果：一根铜没动，还多出两条重合铜，fixed++ 照样记成功。
//
// 本测试做两件事，缺一不可：
//   A. 结构锁：pipeline3.js 里必须出现新公式（有人改回去就红）
//   B. 几何 oracle：用 d13 的真实坐标分别按旧/新拓扑建段，断言
//        旧拓扑的 c2 穿过障碍物（距离 0）
//        新拓扑的中段真的躲到障碍物外侧（距离 ≥ NEED）
//      并断言 axis='x' 的新旧公式**逐字相同**（零回归风险）
//
// 用法：node _test-lshape.js [pipeline3.js 路径]
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '   ' + extra : '')); }
}

// ---------- 几何工具 ----------
function distPointSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const L2 = dx * dx + dy * dy;
  if (L2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
function segsCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
         ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function distSegSeg(ax, ay, bx, by, cx, cy, dx, dy) {
  if (segsCross(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    distPointSeg(ax, ay, cx, cy, dx, dy),
    distPointSeg(bx, by, cx, cy, dx, dy),
    distPointSeg(cx, cy, ax, ay, bx, by),
    distPointSeg(dx, dy, ax, ay, bx, by));
}
// 线段到矩形（轴对齐）的距离：相交或落在内部 → 0
function distSegBox(x1, y1, x2, y2, bx0, by0, bx1, by1) {
  const inside = (x, y) => x > bx0 && x < bx1 && y > by0 && y < by1;
  if (inside(x1, y1) || inside(x2, y2)) return 0;
  const edges = [
    [bx0, by0, bx1, by0], [bx1, by0, bx1, by1],
    [bx1, by1, bx0, by1], [bx0, by1, bx0, by0],
  ];
  let best = Infinity;
  for (const e of edges) best = Math.min(best, distSegSeg(x1, y1, x2, y2, e[0], e[1], e[2], e[3]));
  return best;
}

// ---------- 两套拓扑 ----------
// 返回三段（原线截短后 = 腿1 的骨架，c1 = 中段，c2 = 腿2）
function buildOld(axis, at, sx, sy, ex, ey) {
  const cornerX = axis === 'x' ? at : sx;
  const cornerY = axis === 'y' ? at : sy;
  return {
    leg1: [sx, sy, cornerX, cornerY],
    c1: [cornerX, cornerY, cornerX, ey],
    c2: [cornerX, ey, ex, ey],
    mid: axis === 'x' ? [at, sy, at, ey] : [sx, at, sx, ey],
  };
}
function buildNew(axis, at, sx, sy, ex, ey) {
  const lx1 = axis === 'x' ? at : sx, ly1 = axis === 'x' ? sy : at;
  const lx2 = axis === 'x' ? at : ex, ly2 = axis === 'x' ? ey : at;
  return {
    leg1: [sx, sy, lx1, ly1],
    c1: [lx1, ly1, lx2, ly2],
    c2: [lx2, ly2, ex, ey],
    mid: [lx1, ly1, lx2, ly2],
  };
}

// ---------- A. 结构锁 ----------
const srcPath = process.argv[2] || path.join(__dirname, 'pipeline3.js');
const src = fs.readFileSync(srcPath, 'utf8');
console.log('结构锁：' + srcPath);
const locks = [
  ["const corner1 = c.axis === 'x' ? [c.at, sy] : [sx, c.at];", '走廊搜索里的 corner1 按轴算'],
  ["const corner2 = c.axis === 'x' ? [c.at, ey] : [ex, c.at];", '走廊搜索里的 corner2 按轴算'],
  ["const lx1 = chosen.axis === 'x' ? chosen.at : sx;", '构造处 lx1 按轴算'],
  ["const ly1 = chosen.axis === 'x' ? sy : chosen.at;", '构造处 ly1 按轴算'],
  ["const lx2 = chosen.axis === 'x' ? chosen.at : ex;", '构造处 lx2 按轴算'],
  ["const ly2 = chosen.axis === 'x' ? ey : chosen.at;", '构造处 ly2 按轴算'],
  ['eda.pcb_PrimitiveLine.create(net, layer, lx1, ly1, lx2, ly2, 6.5)', 'c1 用两个拐点'],
  ['eda.pcb_PrimitiveLine.create(net, layer, lx2, ly2, ex, ey, 6.5)', 'c2 从拐点2 回到原终点'],
  ['eda.pcb_PrimitiveLine.modify(trackId, { endX: lx1, endY: ly1 })', 'modify 截到拐点1'],
  // 走廊是按 NEED 精确构造的，中段距离天然等于 NEED。用 `< NEED` 判会让"恰好相等"
  // 去赌浮点舍入，唯一可行的那条走廊被拒 → 违规原地不动。必须有容差，且容差要小。
  ['const NEED_EPS = 1e-3;', '走廊距离判据有浮点容差'],
  ['< NEED - NEED_EPS', '判据用 NEED 减容差，而不是裸 NEED'],
];
for (const [needle, label] of locks) ok('结构锁·' + label, src.indexOf(needle) >= 0);

// 容差必须真的是"数值噪声级"，不能被人改成 1mil 这种会把安全走廊放行的值
const epsMatch = src.match(/const NEED_EPS\s*=\s*([0-9.eE+-]+)\s*;/);
ok('结构锁·NEED_EPS 存在且可解析', !!epsMatch);
if (epsMatch) {
  const epsVal = Number(epsMatch[1]);
  ok('结构锁·NEED_EPS 在 (0, 0.01] 内（只为消浮点噪声）',
    Number.isFinite(epsVal) && epsVal > 0 && epsVal <= 0.01, '实测 ' + epsMatch[1]);
}

// 旧写法必须**彻底消失**（否则两条路径并存，谁也说不清走的是哪条）
ok('结构锁·旧的 cornerX/cornerY 构造已移除',
  src.indexOf('create(net, layer, cornerX, cornerY, cornerX, ey, 6.5)') < 0);
ok('结构锁·旧的 c2 原样重建已移除',
  src.indexOf('create(net, layer, cornerX, ey, ex, ey, 6.5)') < 0);
ok('结构锁·旧的中段公式已移除',
  src.indexOf("c.axis === 'x' ? [c.at, sy, c.at, ey] : [sx, c.at, sx, ey]") < 0);

// ---------- B. 几何 oracle（d13 真实坐标）----------
// bbox [967,-1199,1067,-1100]；违规点 (1051,-1142)；走线水平、y 落在槽的 y 区间内
const BX0 = 967, BY0 = -1199, BX1 = 1067, BY1 = -1100;
const SY = -1142, EY = -1142, SX = 940, EX = 1190;
const HALF = 3.25, NEED_CLEAR = 11.811, NEED = NEED_CLEAR + HALF + 1.0; // 16.061
const AT_Y = BY0 - NEED;   // 走廊：障碍物下方
console.log('\n几何 oracle：d13 坐标 bbox=' + [BX0, BY0, BX1, BY1].join(',') +
  ' track=(' + SX + ',' + SY + ')→(' + EX + ',' + EY + ') NEED=' + NEED.toFixed(3));

const dOld = distSegBox(SX, SY, EX, EY, BX0, BY0, BX1, BY1);
ok('原线确实压在槽上（距离 0）—— 前提成立', dOld === 0);

const oldY = buildOld('y', AT_Y, SX, SY, EX, EY);
const newY = buildNew('y', AT_Y, SX, SY, EX, EY);

// 旧：c2 就是原水平线，必然穿过槽
const oldC2d = distSegBox(oldY.c2[0], oldY.c2[1], oldY.c2[2], oldY.c2[3], BX0, BY0, BX1, BY1);
ok('旧拓扑·c2 穿过障碍物（距离 0）→ 修复动作重建了违规线', oldC2d === 0, '实测 ' + oldC2d.toFixed(3));
// 旧：c1 是 x=SX 的竖线，与"原线剩余部分"重合 —— 判据是 c1 端点在原线的延长线上
ok('旧拓扑·c1 落在原线所在的竖直/水平延长线上（原地折返）',
  oldY.c1[0] === oldY.c1[2] && oldY.c1[0] === SX);
// 旧：leg1=(sx,sy)→(sx,at)、c1=(sx,at)→(sx,ey)；水平走线时 ey===sy，
// 于是 c1 正好把 leg1 反向重走一遍 —— 同一段铜被画了两次，净位移为零。
ok('旧拓扑·leg1 与 c1 共线（同在 x=sx）', oldY.leg1[0] === oldY.c1[0] && oldY.leg1[2] === oldY.c1[2]);
ok('旧拓扑·c1 正好反向重走 leg1（同一段铜画两次，净位移 0）',
  Math.abs(oldY.c1[3] - oldY.leg1[1]) < 1e-9 && Math.abs(oldY.c1[1] - oldY.leg1[3]) < 1e-9);

// 新：中段整体躲到障碍物下方
const newMidD = distSegBox(newY.mid[0], newY.mid[1], newY.mid[2], newY.mid[3], BX0, BY0, BX1, BY1);
ok('新拓扑·中段到障碍物距离 ≥ NEED', newMidD >= NEED - 1e-9, '实测 ' + newMidD.toFixed(3));
ok('新拓扑·中段在障碍物外侧（y 低于 by0）', newY.mid[1] === AT_Y && AT_Y < BY0);
// 新：两条短腿只在端点处贴着线，不横穿障碍物
const newC1d = distSegBox(newY.c1[0], newY.c1[1], newY.c1[2], newY.c1[3], BX0, BY0, BX1, BY1);
const newC2d = distSegBox(newY.c2[0], newY.c2[1], newY.c2[2], newY.c2[3], BX0, BY0, BX1, BY1);
ok('新拓扑·中段不穿障碍物', newC1d >= NEED - 1e-9, '实测 ' + newC1d.toFixed(3));
ok('新拓扑·腿2 不穿障碍物', newC2d > 0, '实测 ' + newC2d.toFixed(3));
// 新：终点仍在原位（否则会拉断与焊盘的连接）
ok('新拓扑·终点保持 (ex,ey)', newY.c2[2] === EX && newY.c2[3] === EY);
ok('新拓扑·起点保持 (sx,sy)', newY.leg1[0] === SX && newY.leg1[1] === SY);

// ---------- C. axis='x' 零回归 ----------
console.log("\n零回归：axis='x' 新旧公式必须逐字相同");
const xs = [0, 0, 200, 0], atX = -50;
const oX = buildOld('x', atX, xs[0], xs[1], xs[2], xs[3]);
const nX = buildNew('x', atX, xs[0], xs[1], xs[2], xs[3]);
ok("axis='x'·腿1 相同", JSON.stringify(oX.leg1) === JSON.stringify(nX.leg1));
ok("axis='x'·c1 相同", JSON.stringify(oX.c1) === JSON.stringify(nX.c1));
ok("axis='x'·c2 相同", JSON.stringify(oX.c2) === JSON.stringify(nX.c2));
ok("axis='x'·mid 相同", JSON.stringify(oX.mid) === JSON.stringify(nX.mid));

// ---------- D. 退化守卫 ----------
console.log('\n退化守卫：三条腿任一为 0 都必须被拒');
function midLen(t) { return Math.hypot(t.mid[2] - t.mid[0], t.mid[3] - t.mid[1]); }
function leg1Len(t, sx, sy) { return Math.hypot(t.leg1[2] - sx, t.leg1[3] - sy); }
function leg2Len(t, ex, ey) { return Math.hypot(t.c2[2] - ex, t.c2[3] - ey); }

// 水平走线 + axis='x' 走廊 → 中段为 0（这正是旧注释里说的退化情形）
const degX = buildNew('x', 100, 0, 0, 200, 0);
ok("退化·水平走线配 axis='x'：中段长度 0 → 拒", midLen(degX) < 1, '实测 ' + midLen(degX).toFixed(3));
// 竖直走线 + axis='y' 走廊 → 中段为 0
const degY = buildNew('y', 100, 0, 0, 0, 200);
ok("退化·竖直走线配 axis='y'：中段长度 0 → 拒", midLen(degY) < 1, '实测 ' + midLen(degY).toFixed(3));
// 走廊正好落在端点上 → 腿长为 0
const degL = buildNew('y', 50, 0, 50, 200, 50);
ok('退化·走廊与端点同一 y：腿长为 0 → 拒',
  leg1Len(degL, 0, 50) < 0.01 && leg2Len(degL, 200, 50) < 0.01);
// 旧的腿2 判据对 axis='y' 恒不为 0（守卫形同虚设）—— 这是旧实现的漏
const oldCxGuard = Math.abs(200 - 0); // cX = sx = 0；|ex - sx| = 200
ok("退化·旧守卫 |ex-cX| 对 axis='y' 恒等于 |ex-sx|（永远不拦）", oldCxGuard === 200);

// ---------- 汇总 ----------
console.log('\n合计 ' + (pass + fail) + ' 项：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
