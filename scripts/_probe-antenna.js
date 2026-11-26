// 天线端定位探针。
//
// 要回答：ESP32-S3-WROOM-1 在**本地坐标系**里天线朝哪一端，从而确定
// 「把天线放在板子某一端」需要 rotation=N 加上什么偏移。
//
// 方法（不靠猜、不靠记忆）：
//   天线那一端**没有邮票孔焊盘**。所以对每个候选 rotation，分别读
//   「器件整体 bbox」和「全部焊盘的 bbox」，两者中心之差就是一个指向
//   「焊盘集中那一端」的向量 —— 反方向即天线端。
//
// 同时量板框尺寸，判断模组长边到底该沿哪个轴（当前 bbox 1030x748 ⇒ 长边沿 X）。
const out = [];
const log = (k, v) => { out.push({ k, v }); };

const bbOf = (bb) => bb ? {
  minX: Math.round(bb.minX), minY: Math.round(bb.minY),
  maxX: Math.round(bb.maxX), maxY: Math.round(bb.maxY),
  w: Math.round(bb.maxX - bb.minX), h: Math.round(bb.maxY - bb.minY),
  cx: Math.round((bb.minX + bb.maxX) / 2), cy: Math.round((bb.minY + bb.maxY) / 2),
} : null;

// 找 U1
let u1Id = null, u1Before = null;
try {
  const ids = (await eda.pcb_PrimitiveComponent.getAllPrimitiveId()) || [];
  const comps = await eda.pcb_PrimitiveComponent.get(ids);
  const arr = (Array.isArray(comps) ? comps : [comps]).filter(Boolean);
  const c = arr.find(x => x.getState_Designator?.() === 'U1');
  if (c) {
    u1Id = c.getState_PrimitiveId();
    u1Before = { x: c.getState_X(), y: c.getState_Y(), rot: c.getState_Rotation() };
  }
} catch (e) { log('findErr', String(e && e.message).slice(0, 160)); }
log('U1', { id: String(u1Id), before: u1Before });

// 板框
try {
  const plIds = (await eda.pcb_PrimitivePolyline.getAllPrimitiveId()) || [];
  for (const id of plIds) {
    const pl = await eda.pcb_PrimitivePolyline.get(id);
    if (pl?.getState_Layer?.() !== 11) continue;
    const src = pl?.getState_Polygon?.()?.getSource?.();
    log('boardOutline', Array.isArray(src) ? src.slice(0, 8) : String(src));
    const bb = await eda.pcb_Primitive.getPrimitivesBBox([id]);
    log('boardBBox', bbOf(bb));
  }
} catch (e) { log('boardErr', String(e && e.message).slice(0, 160)); }

// 各 rotation 下量引脚分布
if (u1Id) {
  for (const rot of [0, 90, 180, 270]) {
    try {
      await eda.pcb_PrimitiveComponent.modify(u1Id, { rotation: rot });
      const c = await eda.pcb_PrimitiveComponent.get(u1Id);
      const rotNow = c?.getState_Rotation?.();
      const compBb = await eda.pcb_Primitive.getPrimitivesBBox([u1Id]);

      // 全部焊盘
      let padBb = null, padN = 0;
      try {
        const pins = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(u1Id);
        const pinArr = Array.isArray(pins) ? pins.filter(Boolean) : [];
        padN = pinArr.length;
        if (padN > 0) {
          const pids = pinArr.map(p => p.getState_PrimitiveId?.()).filter(Boolean);
          padBb = await eda.pcb_Primitive.getPrimitivesBBox(pids);
        }
      } catch (e) { log('pinsErr_' + rot, String(e && e.message).slice(0, 100)); }

      const cb = bbOf(compBb), pb = bbOf(padBb);
      // 焊盘中心相对器件中心的方向 = 焊盘集中方向；天线在反方向
      const antennaDir = cb && pb
        ? { dx: Math.round(cb.cx - pb.cx), dy: Math.round(cb.cy - pb.cy) } : null;
      let antennaSide = null;
      if (antennaDir) {
        if (Math.abs(antennaDir.dx) >= Math.abs(antennaDir.dy)) {
          antennaSide = antennaDir.dx > 0 ? '+X' : '-X';
        } else {
          antennaSide = antennaDir.dy > 0 ? '+Y' : '-Y';
        }
      }
      log('rot' + rot, {
        rotNow, padN, comp: cb, pads: pb,
        antennaOffset: antennaDir, antennaSide,
      });
    } catch (e) { log('rotErr_' + rot, String(e && e.message).slice(0, 160)); }
  }

  // 复位
  try {
    await eda.pcb_PrimitiveComponent.modify(u1Id, {
      x: u1Before.x, y: u1Before.y, rotation: u1Before.rot });
    const c = await eda.pcb_PrimitiveComponent.get(u1Id);
    log('restored', {
      x: c?.getState_X?.(), y: c?.getState_Y?.(), rot: c?.getState_Rotation?.(),
      ok: Math.abs((c?.getState_X?.() || 0) - u1Before.x) < 1
          && Math.abs((c?.getState_Y?.() || 0) - u1Before.y) < 1,
    });
  } catch (e) { log('restoreErr', String(e && e.message).slice(0, 160)); }
}

return { ok: true, probe: out };
