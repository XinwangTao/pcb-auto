const A=__CLI__.args; const L=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await eda.dmt_Project.openProject(A.proj);
await sleep(2500); await eda.dmt_Project.waitForReady(A.proj,60000);
const b=(await eda.dmt_Board.getAllBoardsInfo())[0];
await eda.dmt_EditorControl.openDocument(b.pcb.uuid);
await eda.dmt_EditorControl.waitForDocumentReady(b.pcb.uuid,120000);
await sleep(2000);
const comps=[];
for(const id of await eda.pcb_PrimitiveComponent.getAllPrimitiveId()){
  const c=await eda.pcb_PrimitiveComponent.get(id);
  comps.push({des:c?.getState_Designator?.(), x:Math.round(c?.getState_X?.()), y:Math.round(c?.getState_Y?.())});
}
L.push({comps});
for(const id of (await eda.pcb_PrimitivePolyline.getAllPrimitiveId())){
  const pl=await eda.pcb_PrimitivePolyline.get(id);
  if(pl?.getState_Layer?.()===11) L.push({outline:JSON.stringify(pl.getState_Polygon?.()?.getSource?.()||null)});
}
L.push({lineCount:(await eda.pcb_PrimitiveLine.getAllPrimitiveId()).length});
return L;
