// _test-leg-sweep.js —— 锁住走廊法"两条腿"判据。
//
// 缺陷：L 形走廊（S→corner1→corner2→E）只验了**中段**到障碍物的距离。
// 若原线两端都在障碍物同一侧，"把中段搬到另一侧"的那条腿必然横扫整个盒宽 ——
// 它长度不为 0（退化守卫拦不住），改道因此**自己制造新违规**。
//
// 实测 d12 expand-1.25x（out\USBC_Power_ESD-20261126-002156\_log-2-expand-1.25x.json）：
//   trackRerouted {line:"98a6b24e0a180f46", corridor:"x", at:1040,
//                  obstacleType:"Slot Region", objId:"a69e700e87266079e55",
//                  padBBox:[1056,-1241,1081,-1217], need:12, cur:5}
//   → 搬到槽盒**左**侧 16mil 处，下一轮 clearDiag 违规点却仍在 [1084,-1229]（槽**右**侧），
//     cur 仅 4.6015 / need 11.811。改道没修好任何东西，还多了条违规。
//
// 阈值取 **NEED - NEED_EPS**（与中段同口径），不是"只要不穿过"：
// 走廊分支的契约是"三段都让开障碍"。中段要 NEED 而腿只要"不穿过"，契约就自相矛盾 ——
// 会出现中段合格、腿只有 5mil 的改道：违规没消除，原线却被截短、多造两段铜。
// 腿达不到 NEED ⇒ 这条走廊本来就不可能修好这处违规。
//
// 守四件事：
//   A. 结构：两条腿判据存在、与中段同阈值、位置在中段之后 chosen 之前；
//   B. 几何 oracle：5 个场景，横扫/擦边的必须拒，够远的必须收；
//   C. "只拦穿过"是错的：证明 1e-3 口径会放过擦边场景（阈值选择是承重的，不是随手写）；
//   D. 反向对照：旧判据（只看中段）必须收下 B 里全部判据红场景，否则用例没鉴别力。
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

// ───────── 几何原语（独立实现，不复用被测代码） ─────────
const ptSeg = (px, py, x1, y1, x2, y2) => {
  const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
  if (L2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
};
const segHit = (a, b, c, d) => {
  const cr = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cr(c, d, a), d2 = cr(c, d, b), d3 = cr(a, b, c), d4 = cr(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (o, p, q) => Math.abs(cr(o, p, q)) < 1e-9 &&
    Math.min(o[0], p[0]) - 1e-9 <= q[0] && q[0] <= Math.max(o[0], p[0]) + 1e-9 &&
    Math.min(o[1], p[1]) - 1e-9 <= q[1] && q[1] <= Math.max(o[1], p[1]) + 1e-9;
  return on(c, d, a) || on(c, d, b) || on(a, b, c) || on(a, b, d);
};
const segSeg = (a, b, c, d) => segHit(a, b, c, d) ? 0 : Math.min(
  ptSeg(a[0], a[1], c[0], c[1], d[0], d[1]), ptSeg(b[0], b[1], c[0], c[1], d[0], d[1]),
  ptSeg(c[0], c[1], a[0], a[1], b[0], b[1]), ptSeg(d[0], d[1], a[0], a[1], b[0], b[1]));
const segRect = (seg, box) => {
  const [x0, y0, x1, y1] = box;
  const A = [seg[0], seg[1]], B = [seg[2], seg[3]];
  const inside = (q) => q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1;
  if (inside(A) || inside(B)) return 0;
  const E = [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]];
  return Math.min(...E.map(e => segSeg(A, B, [e[0], e[1]], [e[2], e[3]])));
};

// ───────── 判据复刻 ─────────
// legs: 'none' = 旧判据（只看中段）；'eps' = 只拦穿过；'need' = 现版（与中段同口径）
const corridorOk = (legs) => (obs, sx, sy, ex, ey, c, NEED) => {
  const corner1 = c.axis === 'x' ? [c.at, sy] : [sx, c.at];
  const corner2 = c.axis === 'x' ? [c.at, ey] : [ex, c.at];
  const mid = [corner1[0], corner1[1], corner2[0], corner2[1]];
  if (Math.hypot(mid[2] - mid[0], mid[3] - mid[1]) < 1) return false;
  if (Math.hypot(corner1[0] - sx, corner1[1] - sy) < 0.01) return false;
  if (Math.hypot(ex - corner2[0], ey - corner2[1]) < 0.01) return false;
  const EPS = 1e-3;
  if (segRect(mid, obs) < NEED - EPS) return false;
  const th = legs === 'need' ? NEED - EPS : (legs === 'eps' ? 1e-3 : null);
  if (th !== null) {
    if (segRect([sx, sy, corner1[0], corner1[1]], obs) < th) return false;
    if (segRect([corner2[0], corner2[1], ex, ey], obs) < th) return false;
  }
  return true;
};
const nowOk = corridorOk('need');
const epsOk = corridorOk('eps');
const oldOk = corridorOk('none');

// ───────── 场景（槽盒来自实测，NEED=12） ─────────
const BOX = [1056, -1241, 1081, -1217];
const NEED = 12;
const LEFT = { axis: 'x', at: BOX[0] - NEED };   // 1044
const CASES = [
  { n: '腿1 横扫（两端都在盒右侧，走廊搬到左侧）', sx: 1100, sy: -1229, ex: 1150, ey: -1300, reject: true },
  { n: '腿2 横扫（终点在盒内 y 段）', sx: 1100, sy: -1300, ex: 1150, ey: -1229, reject: true },
  { n: '腿1 擦边 5mil（未穿过但远不到 NEED 12）', sx: 1100, sy: -1212, ex: 1150, ey: -1300, reject: true },
  { n: '同侧正确（起点已在盒左侧，腿正好 12）', sx: 1000, sy: -1229, ex: 1150, ey: -1300, reject: false },
  { n: '两端跨过盒（腿都在盒外 59/67）', sx: 1100, sy: -1300, ex: 1100, ey: -1150, reject: false },
];

for (const t of CASES) {
  const got = nowOk(BOX, t.sx, t.sy, t.ex, t.ey, LEFT, NEED);
  ok('B ' + t.n + ' → ' + (t.reject ? '拒' : '收'), got === !t.reject, '实际 ' + (got ? '收' : '拒'));
  if (t.reject) {
    ok('D 旧判据「' + t.n + '」必须收下（证明新判据真的新增了拦截）',
      oldOk(BOX, t.sx, t.sy, t.ex, t.ey, LEFT, NEED) === true, '旧判据也拒 → 用例无鉴别力');
  }
}

// C 「只拦穿过」口径会放过擦边场景 —— 阈值选择承重
const graze = CASES[2];
ok('C 1e-3 口径会放过擦边场景（所以用 NEED 是刻意的，不是等价写法）',
  epsOk(BOX, graze.sx, graze.sy, graze.ex, graze.ey, LEFT, NEED) === true,
  '1e-3 口径也拒了 → 该断言失效');
ok('C 现版口径必须拒掉同一个擦边场景',
  nowOk(BOX, graze.sx, graze.sy, graze.ex, graze.ey, LEFT, NEED) === false);

// ───────── A. 源码结构锁 ─────────
const has = (s) => src.indexOf(s) >= 0;
const iMid = src.indexOf("geoDistSeg(obs, mid[0], mid[1], mid[2], mid[3]) < NEED - NEED_EPS");
const iL1 = src.indexOf("geoDistSeg(obs, sx, sy, corner1[0], corner1[1]) < NEED - NEED_EPS");
const iL2 = src.indexOf("geoDistSeg(obs, corner2[0], corner2[1], ex, ey) < NEED - NEED_EPS");
const iChosen = src.indexOf('chosen = c;');

ok('A1 中段判据存在', iMid >= 0);
ok('A2 腿1 判据存在且与中段同阈值', iL1 >= 0, '缺 leg1 或阈值不是 NEED - NEED_EPS');
ok('A3 腿2 判据存在且与中段同阈值', iL2 >= 0, '缺 leg2 或阈值不是 NEED - NEED_EPS');
ok('A4 顺序：中段 < 腿1 < 腿2', iMid < iL1 && iL1 < iL2, iMid + '/' + iL1 + '/' + iL2);
ok('A5 都在 chosen 之前（否则采纳了才检查＝没检查）',
  iMid > 0 && iMid < iChosen && iL2 < iChosen, 'iL2=' + iL2 + ' chosen=' + iChosen);
ok('A6 腿判据没用 1e-3（那是被否掉的"只拦穿过"口径）',
  !has('sx, sy, corner1[0], corner1[1]) < 1e-3'), '腿1 还是 1e-3');

// 几何可信度标签：bbox 冒充的轮廓必须可分辨（kind 不能改，改了 geoDistSeg 返回 Infinity）
ok('E1 universalGeo 带 src 标签', has("src: 'bbox',"), '缺 src 标签');
ok('E2 universalGeo 的 kind 仍是 poly（改掉会让判据恒真）',
  has("kind: 'poly', owner: 'universal',"), 'kind 被改坏了');
ok('E3 trackRerouted 落 geoTrusted', has('geoTrusted: obs.src !=='), '日志分辨不出假几何');

if (fails.length) {
  console.error('FAIL  ' + (pass + fails.length - fails.length) + '/' + (pass + fails.length) + ' 通过');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('PASS  ' + pass + '/' + pass + ' 通过  (腿判据与中段同口径 NEED - NEED_EPS)');
process.exit(0);
