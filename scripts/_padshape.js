const A=__CLI__.args; const L=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await eda.dmt_Project.openProject(A.proj);
await sleep(2500); await eda.dmt_Project.waitForReady(A.proj,60000);
const b=(await eda.dmt_Board.getAllBoardsInfo())[0];
await eda.dmt_EditorControl.openDocument(b.pcb.uuid);
await eda.dmt_EditorControl.waitForDocumentReady(b.pcb.uuid,120000);
await sleep(2000);
// 每个器件及其焊盘
const out=[];
for(const cid of await eda.pcb_PrimitiveComponent.getAllPrimitiveId()){
  const c=await eda.pcb_PrimitiveComponent.get(cid);
  const des=c?.getState_Designator?.();
  const pads=[];
  try{
    const pids=await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId?.(cid) || [];
    for(const pid of pids){
      const p=await eda.pcb_PrimitivePad.get(pid);
      pads.push({n:p?.getState_Number?.(), net:p?.getState_Net?.(),
        x:Math.round(p?.getState_X?.()), y:Math.round(p?.getState_Y?.()),
        w:Math.round(p?.getState_Width?.()), h:Math.round(p?.getState_Height?.())});
    }
  }catch(e){ pads.push({err:String(e&&e.message).slice(0,100)}); }
  out.push({des, x:Math.round(c?.getState_X?.()), y:Math.round(c?.getState_Y?.()), pads});
}
L.push({comps:out});
return L;
