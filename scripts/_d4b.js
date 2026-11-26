const A=__CLI__.args; const L=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await eda.dmt_Project.openProject(A.proj);
await sleep(2500); await eda.dmt_Project.waitForReady(A.proj,60000);
const b=(await eda.dmt_Board.getAllBoardsInfo())[0];
await eda.dmt_EditorControl.openDocument(b.pcb.uuid);
await eda.dmt_EditorControl.waitForDocumentReady(b.pcb.uuid,120000);
await sleep(2000);
// 器件位置
const comps=[];
for(const id of await eda.pcb_PrimitiveComponent.getAllPrimitiveId()){
  const c=await eda.pcb_PrimitiveComponent.get(id);
  comps.push({des:c?.getState_Designator?.(), x:c?.getState_X?.(), y:c?.getState_Y?.(),
    layer:c?.getState_Layer?.()});
}
L.push({comps});
// 板框
for(const id of (await eda.pcb_PrimitivePolyline.getAllPrimitiveId())){
  const pl=await eda.pcb_PrimitivePolyline.get(id);
  if(pl?.getState_Layer?.()===11) L.push({outline:JSON.stringify(pl.getState_Polygon?.()?.getSource?.()||null)});
}
// 走线数
L.push({lineCount:(await eda.pcb_PrimitiveLine.getAllPrimitiveId()).length});
const nets=await eda.pcb_Net.getAllNetsName();
const lens=[];
for(const n of nets){ try{ lens.push({n, len:Math.round(await eda.pcb_Net.getNetLength(n))}); }catch(e){} }
L.push({lens});
return L;
