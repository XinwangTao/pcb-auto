// 探针：读取当前会话工程的板框 / 覆铜 / 器件 / 焊盘实际情况
const A = __CLI__.args || {};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const R = { args: A };

const pcbs = await eda.dmt_Pcb.getAllPcbsInfo();
R.pcbs = (pcbs || []).map(p => ({ uuid: p.uuid, name: p.name || p.title, board: p.boardName }));
const pcbUuid = A.pcbUuid || pcbs[0].uuid;
await eda.dmt_EditorControl.openDocument(pcbUuid);
await eda.dmt_EditorControl.waitForDocumentReady(pcbUuid, 90000);
await sleep(2500);

// 板框：layer 11 的 polyline
R.outlines = [];
try {
  const plIds = await eda.pcb_PrimitivePolyline.getAllPrimitiveId();
  for (const id of (plIds || [])) {
    const pl = await eda.pcb_PrimitivePolyline.get(id);
    if (!pl) continue;
    const layer = pl.getState_Layer ? pl.getState_Layer() : null;
    if (layer !== 11) continue;
    let src = null;
    try { src = pl.getState_Polygon().getSource(); } catch (e) { src = 'err:' + e.message; }
    R.outlines.push({ id, layer, src });
  }
} catch (e) { R.outlineErr = String(e && e.message).slice(0, 200); }

// 覆铜
R.pours = [];
const dump = (v) => { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return String(v).slice(0, 300); } };
try {
  const all = await eda.pcb_PrimitivePour.getAll();
  for (const p of (all || [])) R.pours.push(dump(p));
} catch (e) { R.pourErr = String(e && e.message).slice(0, 200); }

// 器件 bbox
R.components = [];
try {
  const ids = await eda.pcb_PrimitiveComponent.getAllPrimitiveId();
  for (const id of (ids || [])) {
    const c = await eda.pcb_PrimitiveComponent.get(id);
    if (!c) continue;
    const des = c.getState_Designator ? c.getState_Designator() : (c.designator || '?');
    const x = c.getState_X ? c.getState_X() : c.x;
    const y = c.getState_Y ? c.getState_Y() : c.y;
    R.components.push({ des, x, y });
  }
} catch (e) { R.compErr = String(e && e.message).slice(0, 200); }

// 图元计数
R.counts = {};
for (const [k, api] of [['line', 'pcb_PrimitiveLine'], ['via', 'pcb_PrimitiveVia'], ['pad', 'pcb_PrimitivePad']]) {
  try { R.counts[k] = (await eda[api].getAllPrimitiveId() || []).length; } catch (e) { R.counts[k] = 'err:' + String(e && e.message).slice(0, 80); }
}

// 当前 DRC
try {
  R.drcPassedNow = await eda.pcb_Drc.check(true, false, false);
  const d = await eda.pcb_Drc.check(true, false, true);
  R.drcTree = JSON.parse(JSON.stringify(d));
} catch (e) { R.drcErr = String(e && e.message).slice(0, 200); }

return R;
