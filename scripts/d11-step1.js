const A = __CLI__.args;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = { steps: [] };
const step = async (name, fn) => {
  try { const v = await fn(); out.steps.push({ name, ok: true, v }); return v; }
  catch (e) { out.steps.push({ name, ok: false, err: String(e && e.message).slice(0, 300) }); return null; }
};
await step('projList', async () => {
  const list = await eda.dmt_Project.getAllProjects?.();
  return Array.isArray(list) ? list.length : typeof list;
});
await step('openProject', async () => eda.dmt_Project.openProject(A.uuid));
await sleep(3000);
await step('pcbs', async () => {
  const p = await eda.dmt_Pcb.getAllPcbsInfo();
  return (p || []).map(x => ({ uuid: x.uuid, name: x.name, docType: x.docType }));
});
await step('boards', async () => {
  const b = await eda.dmt_Board.getAllBoardsInfo();
  return (b || []).map(x => ({ name: x.name, sch: x.schematic?.uuid, pcb: x.pcb?.uuid }));
});
return out;
