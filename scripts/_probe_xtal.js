const A = __CLI__.args;
await eda.dmt_Project.openProject(A.uuid);
await new Promise(r => setTimeout(r, 3000));
const pcbs = await eda.dmt_Pcb.getAllPcbsInfo();
await eda.dmt_EditorControl.openDocument(pcbs[0].uuid);
await eda.dmt_EditorControl.waitForDocumentReady(pcbs[0].uuid, 60000);
await new Promise(r => setTimeout(r, 2000));

// XTAL_IN 网络有哪些焊盘/线段？这条斜线两端应该接哪儿
const pads = [];
for (const id of (await eda.pcb_PrimitivePad.getAllPrimitiveId()) || []) {
  try { const p = await eda.pcb_PrimitivePad.get(id);
    if (String(p?.getState_Net?.()).toUpperCase() === 'XTAL_IN')
      pads.push({ id, num: p.getState_PadNumber?.(), x: +p.getState_X().toFixed(2), y: +p.getState_Y().toFixed(2) });
  } catch (e) {}
}
const lines = [];
for (const id of (await eda.pcb_PrimitiveLine.getAllPrimitiveId()) || []) {
  try { const l = await eda.pcb_PrimitiveLine.get(id);
    if (String(l?.getState_Net?.()).toUpperCase() === 'XTAL_IN')
      lines.push({ id, layer: l.getState_Layer?.(),
        s: [+l.getState_StartX().toFixed(2), +l.getState_StartY().toFixed(2)],
        e: [+l.getState_EndX().toFixed(2), +l.getState_EndY().toFixed(2)], w: l.getState_LineWidth?.() });
  } catch (e) {}
}
const vias = [];
for (const id of (await eda.pcb_PrimitiveVia.getAllPrimitiveId()) || []) {
  try { const v = await eda.pcb_PrimitiveVia.get(id);
    if (String(v?.getState_Net?.()).toUpperCase() === 'XTAL_IN')
      vias.push({ id, x: +v.getState_X().toFixed(2), y: +v.getState_Y().toFixed(2) });
  } catch (e) {}
}
// Y1 器件焊盘全览（晶振 4 脚）
const y1 = [];
for (const id of (await eda.pcb_PrimitivePad.getAllPrimitiveId()) || []) {
  try { const p = await eda.pcb_PrimitivePad.get(id);
    const x = p.getState_X(), y = p.getState_Y();
    if (Math.hypot(x - 1349.5, y + 129.4) < 120)
      y1.push({ id, num: p.getState_PadNumber?.(), net: p.getState_Net?.(),
        x: +x.toFixed(2), y: +y.toFixed(2) });
  } catch (e) {}
}
return { xtalInPads: pads, xtalInLines: lines, xtalInVias: vias, y1Pads: y1 };
