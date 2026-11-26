const A = __CLI__.args;
await eda.dmt_Project.openProject(A.uuid);
await new Promise(r => setTimeout(r, 3000));
const pcbs = await eda.dmt_Pcb.getAllPcbsInfo();
await eda.dmt_EditorControl.openDocument(pcbs[0].uuid);
await eda.dmt_EditorControl.waitForDocumentReady(pcbs[0].uuid, 60000);
await new Promise(r => setTimeout(r, 2000));

// 删掉我手工加的 XTAL_IN 线段（e361~e364 这些新编号），以及残留
const dels = [];
for (const id of (await eda.pcb_PrimitiveLine.getAllPrimitiveId()) || []) {
  try { const l = await eda.pcb_PrimitiveLine.get(id);
    if (String(l?.getState_Net?.()).toUpperCase() !== 'XTAL_IN') continue;
    const sx = l.getState_StartX(), sy = l.getState_StartY();
    const ex = l.getState_EndX(), ey = l.getState_EndY();
    // 只删 y < -190 或 x < 1310 的那些（我加的都是这类）
    if (Math.min(sy, ey) < -190 || Math.min(sx, ex) < 1310) { dels.push(id); }
  } catch (e) {}
}
for (const id of dels) { try { await eda.pcb_PrimitiveLine.delete(id); } catch (e) {} }
await eda.pcb_Document.save();
await new Promise(r => setTimeout(r, 2000));
const d = await eda.pcb_Drc.check(true, false, true);
const flat = [];
const walk = (n) => { if (!n) return; if (Array.isArray(n)) { n.forEach(walk); return; }
  if (n.errorType) flat.push({ t: n.errorType, s1: n.explanation?.errData?.obj1Suffix,
    s2: n.explanation?.errData?.obj2Suffix, min: n.explanation?.param?.minDistance }); if (n.list) walk(n.list); };
walk(d);
return { deleted: dels.length, remaining: flat.length, items: flat.slice(0, 8) };
