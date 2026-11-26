const A = __CLI__.args;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = { steps: [] };
const step = async (name, fn) => {
  try { const v = await fn(); out.steps.push({ name, ok: true, v: typeof v === 'object' ? JSON.parse(JSON.stringify(v, (k, x) => typeof x === 'function' ? undefined : x)) : v }); return v; }
  catch (e) { out.steps.push({ name, ok: false, err: String(e && e.message).slice(0, 400) }); return null; }
};
await step('openProject', async () => eda.dmt_Project.openProject(A.uuid));
await sleep(3000);
const pcbs = await eda.dmt_Pcb.getAllPcbsInfo();
out.pcbs = (pcbs || []).map(x => x.uuid);
const pcb = (pcbs || [])[0];
await step('openDoc', async () => eda.dmt_EditorControl.openDocument(pcb.uuid));
await sleep(2000);
await step('waitReady', async () => eda.dmt_EditorControl.waitForDocumentReady(pcb.uuid, 60000));
await sleep(1500);
await step('activeDoc', async () => {
  const d = await eda.dmt_EditorControl.getActiveDocument?.();
  return d ? { uuid: d.uuid, name: d.name } : 'null';
});
await step('lineIds', async () => (await eda.pcb_PrimitiveLine.getAllPrimitiveId() || []).length);
await step('padIds', async () => (await eda.pcb_PrimitivePad.getAllPrimitiveId() || []).length);
await step('viaIds', async () => (await eda.pcb_PrimitiveVia.getAllPrimitiveId() || []).length);
await step('pourIds', async () => (await eda.pcb_PrimitivePour.getAllPrimitiveId?.() || []).length);
await step('rebuildPour', async () => eda.pcb_PrimitivePour.rebuildAllCopperRegions());
await sleep(2500);
await step('drcBool', async () => eda.pcb_Drc.check(true, false, false));
await step('drcTreeLen', async () => { const t = await eda.pcb_Drc.check(true, false, true); return Array.isArray(t) ? t.length : typeof t; });
return out;
