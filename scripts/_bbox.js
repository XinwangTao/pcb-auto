const A=__CLI__.args;
const L=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await eda.dmt_Project.openProject(A.proj);
await sleep(2000); await eda.dmt_Project.waitForReady(A.proj,60000);
const b=(await eda.dmt_Board.getAllBoardsInfo())[0];
await eda.dmt_EditorControl.openDocument(b.pcb.uuid);
await eda.dmt_EditorControl.waitForDocumentReady(b.pcb.uuid,120000);
await sleep(1500);
const pads=[];
for(const id of (await eda.pcb_PrimitivePad.getAllPrimitiveId())){
  const p=await eda.pcb_PrimitivePad.get(id);
  pads.push({net:p?.getState_Net?.(),x:p?.getState_X?.(),y:p?.getState_Y?.()});
}
const xs=pads.map(p=>p.x), ys=pads.map(p=>p.y);
L.push({padCount:pads.length, xMin:Math.min(...xs), xMax:Math.max(...xs), yMin:Math.min(...ys), yMax:Math.max(...ys)});
// 板框
const pl=await eda.pcb_PrimitivePolyline.getAllPrimitiveId();
for(const id of pl){ const p=await eda.pcb_PrimitivePolyline.get(id);
  L.push({outline:p?.getState_Polygon?.()?.getSource?.()}); }
// 器件位置
for(const id of (await eda.pcb_PrimitiveComponent.getAllPrimitiveId())){
  const c=await eda.pcb_PrimitiveComponent.get(id);
  L.push({comp:{des:c?.getState_Designator?.(),x:c?.getState_X?.(),y:c?.getState_Y?.()}});
}
return L;
