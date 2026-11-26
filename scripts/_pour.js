const A=__CLI__.args; const L=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await eda.dmt_Project.openProject(A.proj);
await sleep(2500); await eda.dmt_Project.waitForReady(A.proj,60000);
const b=(await eda.dmt_Board.getAllBoardsInfo())[0];
await eda.dmt_EditorControl.openDocument(b.pcb.uuid);
await eda.dmt_EditorControl.waitForDocumentReady(b.pcb.uuid,120000);
await sleep(2000);
// 覆铜边框
const pours=[];
for(const id of (await eda.pcb_PrimitivePour.getAllPrimitiveId())){
  const p=await eda.pcb_PrimitivePour.get(id);
  pours.push({id, net:p?.getState_Net?.(), layer:p?.getState_Layer?.(),
    name:p?.getState_PourName?.(), prio:p?.getState_PourPriority?.(),
    method:p?.getState_PourFillMethod?.()});
}
L.push({pours});
// 铜区域（真正生成铜的是 Fill 类型）
const fills=[];
for(const id of (await eda.pcb_PrimitiveFill.getAllPrimitiveId())){
  const f=await eda.pcb_PrimitiveFill.get(id);
  fills.push({id, net:f?.getState_Net?.(), layer:f?.getState_Layer?.(), mode:f?.getState_FillMode?.()});
}
L.push({fillCount:fills.length, fills});
// 网络长度
const nets=await eda.pcb_Net.getAllNetsName();
const lens=[];
for(const n of nets){ try{ lens.push({n, len:await eda.pcb_Net.getNetLength(n)}); }catch(e){} }
L.push({nets:nets, lens});
return L;
