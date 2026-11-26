// 坐标系探针（一次性，只读为主，改了就改回去）。
//
// 要回答的唯一问题：`eda.pcb_MathPolygon.createPolygon([...])` 的坐标原点/符号，
// 与 `eda.pcb_PrimitivePad/Component.getState_X/Y`、`pcb_Primitive.getPrimitivesBBox`
// 用的是不是同一套。
//
// 为什么必须实测：文档里 `TPCB_PolygonSourceArray` 注明自己是 SVG 坐标系（Y 向下），
// 而 pro-api 其它位置坐标是笛卡尔（Y 向上），「两者转换时需对 Y 坐标取反」，
// 且「混用不会报错，只会让器件出现在板子外面」。
// 仓库里没有任何一处做过取反 —— 只在「polyline.getSource() → createPolygon」这条
// 自洽链上用它，所以那条链看不出问题。一旦我拿 bbox（笛卡尔）去 createPolygon（SVG）
// 建模型，净空区就会跑到板外，而且不会报错。
//
// 本探针同时量四件事：
//   ① 板框 polyline 的 source 与实际 bbox 的符号关系
//   ② 新建 Region 后读回 bbox，判断是否需要 Y 取反
//   ③ 按位号找器件 + modify 摆放到绝对坐标，读回是否生效
//   ④ 器件被摆到板框外时，DRC 会不会报（决定天线悬出方案可行性）
const out = [];
const log = (k, v) => { out.push({ k, v }); };

const R = {};

// ── ① 板框：source vs bbox ──────────────────────────────
try {
  const plIds = (await eda.pcb_PrimitivePolyline.getAllPrimitiveId()) || [];
  const outline = [];
  for (const id of plIds) {
    const pl = await eda.pcb_PrimitivePolyline.get(id);
    if (pl?.getState_Layer?.() !== 11) continue;
    const src = pl?.getState_Polygon?.()?.getSource?.();
    outline.push({ id: String(id), src: Array.isArray(src) ? src.slice(0, 8) : String(src) });
  }
  log('outlineCount', outline.length);
  log('outlineSources', outline.slice(0, 2));
  if (outline.length) {
    try {
      const bb = await eda.pcb_Primitive.getPrimitivesBBox([outline[0].id]);
      log('outlineBBox', bb ? {
        minX: bb.minX, minY: bb.minY, maxX: bb.maxX, maxY: bb.maxY
      } : null);
    } catch (e) { log('outlineBBoxErr', String(e && e.message).slice(0, 120)); }
  }
} catch (e) { log('outlineErr', String(e && e.message).slice(0, 160)); }

// ── ② Region：用已知坐标建，读回 bbox ───────────────────
// 故意用不对称的矩形，并且 y 给一个明显不为 0 的值，
// 这样「取反 / 不取反 / 翻转」三种结果可以互相区分。
const PROBE = { x: 1200, y: 700, w: 400, h: 200 };
let probeRegionId = null;
try {
  const poly = eda.pcb_MathPolygon.createPolygon(
    ['R', PROBE.x, PROBE.y, PROBE.w, PROBE.h, 0, 0]);
  const reg = await eda.pcb_PrimitiveRegion.create(12, poly, [2, 5, 6, 7], 'PROBE_COORD', 10, false);
  if (reg) {
    probeRegionId = reg.getState_PrimitiveId ? reg.getState_PrimitiveId() : null;
    log('regionCreated', { id: String(probeRegionId), requested: PROBE });
  } else {
    log('regionCreated', null);
  }
  if (probeRegionId) {
    try {
      const bb = await eda.pcb_Primitive.getPrimitivesBBox([probeRegionId]);
      log('regionBBox', bb ? {
        minX: bb.minX, minY: bb.minY, maxX: bb.maxX, maxY: bb.maxY
      } : null);
      // 判读：请求的是 x 1200..1600, y 700..900（SVG 语义）
      // 若 bbox 是 minY=700  maxY=900  → 同号，不取反
      // 若 bbox 是 minY=-900 maxY=-700 → Y 取反
      // 其它          → 还有别的变换，必须另找规律
      if (bb) {
        const same = Math.abs(bb.minY - PROBE.y) < 1 && Math.abs(bb.maxY - (PROBE.y + PROBE.h)) < 1;
        const flip = Math.abs(bb.minY + (PROBE.y + PROBE.h)) < 1 && Math.abs(bb.maxY + PROBE.y) < 1;
        log('coordVerdict', same ? 'SAME(svg==cartesian)'
          : flip ? 'FLIP(cartesian Y = -svg Y)' : 'UNKNOWN');
      }
    } catch (e) { log('regionBBoxErr', String(e && e.message).slice(0, 120)); }
  }
} catch (e) { log('regionCreateErr', String(e && e.message).slice(0, 200)); }

// ── ③ 按位号找器件 + modify ────────────────────────────
let u1 = null;
try {
  const ids = (await eda.pcb_PrimitiveComponent.getAllPrimitiveId()) || [];
  const comps = await eda.pcb_PrimitiveComponent.get(ids);
  const arr = Array.isArray(comps) ? comps : [comps];
  const named = arr.filter(Boolean).map(c => ({
    id: c.getState_PrimitiveId ? c.getState_PrimitiveId() : null,
    des: c.getState_Designator ? c.getState_Designator() : null,
    x: c.getState_X ? c.getState_X() : null,
    y: c.getState_Y ? c.getState_Y() : null,
    rot: c.getState_Rotation ? c.getState_Rotation() : null,
  }));
  log('componentCount', named.length);
  log('designators', named.map(c => c.des));
  u1 = named.find(c => c.des === 'U1') || null;
  log('U1', u1);
  if (u1 && u1.id) {
    try {
      const bb = await eda.pcb_Primitive.getPrimitivesBBox([u1.id]);
      log('U1BBox', bb ? { minX: bb.minX, minY: bb.minY, maxX: bb.maxX, maxY: bb.maxY } : null);
    } catch (e) { log('U1BBoxErr', String(e && e.message).slice(0, 120)); }
  }
} catch (e) { log('componentErr', String(e && e.message).slice(0, 200)); }

// ── ④ modify 真的能挪动吗（挪 +200mil 再挪回，读两次）──────
if (u1 && u1.id && Number.isFinite(u1.x) && Number.isFinite(u1.y)) {
  const before = { x: u1.x, y: u1.y, rot: u1.rot };
  try {
    await eda.pcb_PrimitiveComponent.modify(u1.id, { x: before.x + 200, y: before.y });
    const c2 = await eda.pcb_PrimitiveComponent.get(u1.id);
    const moved = { x: c2?.getState_X?.(), y: c2?.getState_Y?.(), rot: c2?.getState_Rotation?.() };
    log('modifyMoved', { before, after: moved, dx: moved.x - before.x, dy: moved.y - before.y });
    // 摆回去
    await eda.pcb_PrimitiveComponent.modify(u1.id, { x: before.x, y: before.y, rotation: before.rot });
    const c3 = await eda.pcb_PrimitiveComponent.get(u1.id);
    log('modifyRestored', {
      x: c3?.getState_X?.(), y: c3?.getState_Y?.(), rot: c3?.getState_Rotation?.(),
      ok: Math.abs((c3?.getState_X?.() || 0) - before.x) < 1
    });
  } catch (e) { log('modifyErr', String(e && e.message).slice(0, 200)); }
}

// ── 清理：删掉探针 Region ───────────────────────────────
if (probeRegionId) {
  try {
    const del = await eda.pcb_PrimitiveRegion.delete(probeRegionId);
    log('regionDeleted', del === true);
  } catch (e) { log('regionDelErr', String(e && e.message).slice(0, 120)); }
}

return { ok: true, probe: out };
