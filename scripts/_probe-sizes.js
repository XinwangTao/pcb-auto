// 布局用尺寸表探针：读出每个器件的真实包围盒，供手工摆放算坐标用。
//
// 只读：不改任何器件位置/旋转。当前板子上各器件的 rotation 各不相同，
// 所以「自然尺寸」要按旋转把宽高换回来（90/270 时 w/h 互换），
// 记录的是**实测 bbox**，不是封装名里猜的数字。
const out = [];
const log = (k, v) => { out.push({ k, v }); };
const r0 = (n) => Math.round(n);

try {
  const ids = (await eda.pcb_PrimitiveComponent.getAllPrimitiveId()) || [];
  const comps = await eda.pcb_PrimitiveComponent.get(ids);
  const arr = (Array.isArray(comps) ? comps : [comps]).filter(Boolean);

  const rows = [];
  for (const c of arr) {
    const des = c.getState_Designator?.();
    const id = c.getState_PrimitiveId?.();
    const rot = Number(c.getState_Rotation?.() || 0);
    let bb = null;
    try { bb = await eda.pcb_Primitive.getPrimitivesBBox([id]); } catch (e) { }
    if (!bb) { rows.push({ des, rot, bbox: null }); continue; }
    const w = r0(bb.maxX - bb.minX), h = r0(bb.maxY - bb.minY);
    const swapped = (((rot % 180) + 180) % 180) === 90;
    rows.push({
      des, rot,
      w, h,
      natW: swapped ? h : w,   // 自然朝向（rot=0）下的宽
      natH: swapped ? w : h,
      x: r0(c.getState_X?.()), y: r0(c.getState_Y?.()),
    });
  }
  rows.sort((a, b) => String(a.des).localeCompare(String(b.des)));
  log('sizes', rows);
  log('count', rows.length);

  // 板框
  const plIds = (await eda.pcb_PrimitivePolyline.getAllPrimitiveId()) || [];
  for (const id of plIds) {
    const pl = await eda.pcb_PrimitivePolyline.get(id);
    if (pl?.getState_Layer?.() !== 11) continue;
    const bb = await eda.pcb_Primitive.getPrimitivesBBox([id]);
    if (bb) log('board', { w: r0(bb.maxX - bb.minX), h: r0(bb.maxY - bb.minY) });
  }

  // 各网络长度粗估会用到：每个器件的引脚 → 所属网络的映射不存在直接接口，
  // 但 netlist 在 out/<run>/Netlist.json 里，这里不读文件（invoke 沙箱不一定有 fs）。
  // 布局只按「功能分区 + 尺寸」算，不按网表优化 —— 这是有意的：
  // 自动布局按线长优化，结果把麦克风、功放、按键、天线全混在一起。
} catch (e) {
  log('err', String(e && e.message).slice(0, 240));
}

return { ok: true, probe: out };
