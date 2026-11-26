const A=__CLI__.args;
const L=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await eda.dmt_Project.openProject(A.proj);
await sleep(2000); await eda.dmt_Project.waitForReady(A.proj,60000);
const b=(await eda.dmt_Board.getAllBoardsInfo())[0];
await eda.dmt_EditorControl.openDocument(b.pcb.uuid);
await eda.dmt_EditorControl.waitForDocumentReady(b.pcb.uuid,120000);
await sleep(1500);
// 板框 polyline 的 polygon source
const ids=await eda.pcb_PrimitivePolyline.getAllPrimitiveId();
for(const id of ids){
  const p=await eda.pcb_PrimitivePolyline.get(id);
  L.push({id, layer:p?.getState_Layer?.(), net:p?.getState_Net?.(),
    poly:String(p?.getState_Polygon?.()?.getSource?.())});
}
// fill 的 polygon
const fids=await eda.pcb_PrimitiveFill.getAllPrimitiveId();
for(const id of fids){
  const f=await eda.pcb_PrimitiveFill.get(id);
  L.push({fill:id, layer:f?.getState_Layer?.(), net:f?.getState_Net?.(),
    poly:String(f?.getState_Polygon?.()?.getSource?.())});
}
// bbox
try{ L.push({bbox:await eda.pcb_Primitive.getPrimitivesBBox()}); }catch(e){}
return L;
