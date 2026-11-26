// 批量扫描：对每个工程出 DRC 概况 + 焊盘包围盒真值对照（POLYGON/旋转 RECT）
const A = __CLI__.args;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = { done: [] };

async function scanDrc() {
  const passed = await eda.pcb_Drc.check(true, false, false);
  const d = await eda.pcb_Drc.check(true, false, true);
  const flat = [];
  const walk = (n) => { if (!n) return; if (Array.isArray(n)) { n.forEach(walk); return; } if (n.errorType) flat.push(n); if (n.list) walk(n.list); };
  walk(d);
  return {
    passed, total: flat.length,
    types: [...new Set(flat.map(x => x.errorType))],
    items: flat.map(x => {
      const ed = x.explanation?.errData || {};
      return { t: x.errorType, ot: x.errorObjType,
        obj1: ed.obj1, obj1Type: ed.obj1Type, obj1Suffix: ed.obj1Suffix,
        obj2: ed.obj2, obj2Type: ed.obj2Type, obj2Suffix: ed.obj2Suffix,
        pos: ed.position, min: ed.minDistance, param: x.explanation?.param };
    }),
  };
}

for (const uuid of A.uuids) {
  const rec = { uuid };
  try {
    await eda.dmt_Project.openProject(uuid);
    await sleep(2500);
    try { await eda.dmt_Project.waitForReady(uuid, 60000); } catch (e) {}
    const pcbs = await eda.dmt_Pcb.getAllPcbsInfo();
    if (!pcbs || !pcbs.length) { rec.err = 'no pcb'; out.done.push(rec); continue; }
    await eda.dmt_EditorControl.openDocument(pcbs[0].uuid);
    await eda.dmt_EditorControl.waitForDocumentReady(pcbs[0].uuid, 60000);
    await sleep(1500);

    rec.drc = await scanDrc();

    // 焊盘包围盒对照：只挑 POLYGON 与「rot 非 0 且 w≠h」的 RECT
    const rows = [];
    const ids = (await eda.pcb_PrimitivePad.getAllPrimitiveId()) || [];
    for (const id of ids) {
      let p = null;
      try { p = await eda.pcb_PrimitivePad.get(id); } catch (e) { continue; }
      if (!p) continue;
      const raw = p.getState_Pad?.();
      if (!Array.isArray(raw)) continue;
      const rot = Number(p.getState_Rotation?.() ?? 0);
      const isPoly = raw[0] === 'POLYGON';
      const isRect = raw[0] === 'RECT';
      if (!isPoly && !(isRect && rot % 180 !== 0)) continue;
      let bb = null;
      try { bb = await eda.pcb_Primitive.getPrimitivesBBox([id]); } catch (e) { bb = 'err'; }
      let polyBBox = null;
      if (isPoly) {
        const a = raw[1] || []; const vs = [];
        for (let i = 0; i < a.length - 1; i++) if (typeof a[i] === 'number' && typeof a[i + 1] === 'number') vs.push([a[i], a[i + 1]]);
        polyBBox = { x0: Math.min(...vs.map(q => q[0])), x1: Math.max(...vs.map(q => q[0])),
          y0: Math.min(...vs.map(q => q[1])), y1: Math.max(...vs.map(q => q[1])) };
      }
      rows.push({ id, shape: raw[0], w: raw[1], h: raw[2], p3: raw[3], rot,
        cx: p.getState_X(), cy: p.getState_Y(), net: p.getState_Net?.(), num: p.getState_PadNumber?.(),
        apiBBox: bb, polyBBox });
      if (rows.length > 24) break;
    }
    rec.pads = rows;
  } catch (e) { rec.err = String(e && e.message).slice(0, 160); }
  out.done.push(rec);
}
return out;
