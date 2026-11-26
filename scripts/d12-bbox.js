// 真值来源：pcb_Primitive.getPrimitivesBBox(ids) 给出图元真实包围盒
// 用它反推 getState_Pad() 的 w/h 是「旋转前局部尺寸」还是「已旋转」的板轴尺寸
const A = __CLI__.args;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = { projects: [] };

async function openProj(uuid) {
  await eda.dmt_Project.openProject(uuid);
  await sleep(2500);
  try { await eda.dmt_Project.waitForReady(uuid, 60000); } catch (e) { }
  const pcbs = await eda.dmt_Pcb.getAllPcbsInfo();
  await eda.dmt_EditorControl.openDocument(pcbs[0].uuid);
  await eda.dmt_EditorControl.waitForDocumentReady(pcbs[0].uuid, 60000);
  await sleep(1500);
}

for (const uuid of A.uuids) {
  const rec = { uuid, rows: [] };
  try {
    await openProj(uuid);
    const ids = await eda.pcb_PrimitivePad.getAllPrimitiveId();
    // 只挑 RECT，且尽量要 rotation 90/270 且 w≠h
    for (const id of ids) {
      try {
        const p = await eda.pcb_PrimitivePad.get(id);
        const raw = p.getState_Pad?.();
        if (!Array.isArray(raw) || raw[0] !== 'RECT') continue;
        const w = Number(raw[1]), h = Number(raw[2]), p3 = raw[3];
        const rot = Number(p.getState_Rotation?.() ?? 0);
        const cx = Number(p.getState_X()), cy = Number(p.getState_Y());
        let bbox = null;
        try {
          const bb = await eda.pcb_Primitive.getPrimitivesBBox([id]);
          bbox = bb;
        } catch (e) { bbox = 'err:' + String(e && e.message).slice(0, 60); }
        // 归一化：无论返回 {x,y,w,h} / {minX,...} / [x0,y0,x1,y1]
        let nbb = null;
        if (bbox && typeof bbox === 'object') {
          if (Array.isArray(bbox)) nbb = { arr: bbox };
          else nbb = bbox;
        } else nbb = bbox;
        const th = rot * Math.PI / 180;
        const axA = (Math.abs(Math.cos(th)) * w + Math.abs(Math.sin(th)) * h) / 2;  // 旋转前局部尺寸
        const ayA = (Math.abs(Math.sin(th)) * w + Math.abs(Math.cos(th)) * h) / 2;
        rec.rows.push({ id, w, h, p3, rot, cx, cy, nbb,
          formulaA: { ax: +axA.toFixed(3), ay: +ayA.toFixed(3) },
          formulaB: { ax: +(w / 2).toFixed(3), ay: +(h / 2).toFixed(3) },
          net: p.getState_Net?.(), num: p.getState_PadNumber?.(), padType: p.getState_PadType?.() });
      } catch (e) { }
    }
    // 同时验证 POLYGON 的 bbox 是否等于顶点 min/max（已知 d12 e6e35）
    for (const id of ids) {
      try {
        const p = await eda.pcb_PrimitivePad.get(id);
        const raw = p.getState_Pad?.();
        if (!Array.isArray(raw) || raw[0] !== 'POLYGON') continue;
        const a = raw[1] || [];
        const vs = [];
        for (let i = 0; i < a.length - 1; i++) if (typeof a[i] === 'number' && typeof a[i + 1] === 'number') vs.push([a[i], a[i + 1]]);
        const pb = { x0: Math.min(...vs.map(q => q[0])), x1: Math.max(...vs.map(q => q[0])),
          y0: Math.min(...vs.map(q => q[1])), y1: Math.max(...vs.map(q => q[1])) };
        let bb = null; try { bb = await eda.pcb_Primitive.getPrimitivesBBox([id]); } catch (e) { bb = 'err'; }
        rec.polys = rec.polys || [];
        rec.polys.push({ id, rot: p.getState_Rotation?.(), polyBBox: pb, apiBBox: bb, num: p.getState_PadNumber?.() });
      } catch (e) { }
    }
  } catch (e) { rec.err = String(e && e.message).slice(0, 120); }
  out.projects.push(rec);
}
return out;
