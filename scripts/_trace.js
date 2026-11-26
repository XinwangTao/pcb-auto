const A=__CLI__.args; const L=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await eda.dmt_Project.openProject(A.proj);
await sleep(2500); await eda.dmt_Project.waitForReady(A.proj,60000);
const b=(await eda.dmt_Board.getAllBoardsInfo())[0];
await eda.dmt_EditorControl.openDocument(b.pcb.uuid);
await eda.dmt_EditorControl.waitForDocumentReady(b.pcb.uuid,120000);
await sleep(2000);
const lines=[];
for(const id of (await eda.pcb_PrimitiveLine.getAllPrimitiveId())){
  const l=await eda.pcb_PrimitiveLine.get(id);
  lines.push({net:l?.getState_Net?.(), layer:l?.getState_Layer?.(),
    x1:l?.getState_StartX?.(), y1:l?.getState_StartY?.(),
    x2:l?.getState_EndX?.(), y2:l?.getState_EndY?.(), w:String(l?.getState_LineWidth?.())});
}
L.push({lineCount:lines.length, lines});
const vias=[];
for(const id of (await eda.pcb_PrimitiveVia.getAllPrimitiveId())){
  const v=await eda.pcb_PrimitiveVia.get(id);
  vias.push({net:v?.getState_Net?.(), x:v?.getState_X?.(), y:v?.getState_Y?.()});
}
L.push({vias});
const pads=[];
for(const id of (await eda.pcb_PrimitivePad.getAllPrimitiveId())){
  const p=await eda.pcb_PrimitivePad.get(id);
  pads.push({net:p?.getState_Net?.(), x:p?.getState_X?.(), y:p?.getState_Y?.(),
    num:p?.getState_Number?.(), layer:p?.getState_Layer?.()});
}
L.push({pads});
return L;
