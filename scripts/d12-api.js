// 探针：API 反射 —— 焊盘对象方法、文档/工程保存方法
const A = __CLI__.args;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = {};
const names = (o) => { const s = new Set(); let p = o; let d = 0;
  while (p && d < 6) { for (const k of Object.getOwnPropertyNames(p)) if (/^[gs]et(State|Pad|BBox)/.test(k) || /Box|Shape|Rot|Save|Clone|Copy/i.test(k)) s.add(k); p = Object.getPrototypeOf(p); d++; }
  return [...s].sort(); };

await eda.dmt_Project.openProject(A.uuid);
await sleep(2500);
const pcbs = await eda.dmt_Pcb.getAllPcbsInfo();
await eda.dmt_EditorControl.openDocument(pcbs[0].uuid);
await eda.dmt_EditorControl.waitForDocumentReady(pcbs[0].uuid, 60000);
await sleep(1500);

const ids = await eda.pcb_PrimitivePad.getAllPrimitiveId();
const p0 = await eda.pcb_PrimitivePad.get(ids[0]);
out.padMethods = names(p0);
out.padKeysTop = Object.keys(p0).slice(0, 40);

const l0 = await eda.pcb_PrimitiveLine.get((await eda.pcb_PrimitiveLine.getAllPrimitiveId())[0]);
out.lineMethods = names(l0);

out.edaKeys = Object.keys(eda).filter(k => /Pad|Line|Project|Document|Primitive/i.test(k)).sort();
// 工程/文档保存类方法
out.projMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(eda.dmt_Project)).filter(k => /Save|Copy|Clone|Export|Close|Import/i.test(k));
const pd = Object.getPrototypeOf(eda.pcb_Document);
out.docMethods = Object.getOwnPropertyNames(pd).filter(k => /Save|Copy|Clone|Export|Close|Open/i.test(k));

// 焊盘形状与旋转普查：raw[3] 是否等于 rotation
const rows = [];
for (const id of ids) {
  try { const p = await eda.pcb_PrimitivePad.get(id);
    const raw = p.getState_Pad?.();
    rows.push({ id, shape: raw?.[0], p3: raw?.[3], rot: p.getState_Rotation?.(),
      w: raw?.[1], h: raw?.[2], x: p.getState_X?.(), y: p.getState_Y?.() });
  } catch (e) {}
}
out.rectRows = rows.filter(r => r.shape === 'RECT');
out.distinctP3 = [...new Set(rows.map(r => JSON.stringify(r.p3)))];
return out;
