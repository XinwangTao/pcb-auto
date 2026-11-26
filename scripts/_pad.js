const A=__CLI__.args;
const L=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await eda.dmt_Project.openProject(A.proj);
await sleep(2000); await eda.dmt_Project.waitForReady(A.proj,60000);
const b=(await eda.dmt_Board.getAllBoardsInfo())[0];
await eda.dmt_EditorControl.openDocument(b.pcb.uuid);
await eda.dmt_EditorControl.waitForDocumentReady(b.pcb.uuid,120000);
await sleep(1500);
// 读全部 GND 相关铜（line/via/pad）判断实际连通
const lines=[]; for(const id of (await eda.pcb_PrimitiveLine.getAllPrimitiveId())){
  const l=await eda.pcb_PrimitiveLine.get(id);
  lines.push({net:l?.getState_Net?.(),layer:l?.getState_Layer?.(),w:String(l?.getState_LineWidth?.())});
}
L.push({lineCount:lines.length, lines});
// EP 焊盘尺寸
const pads=[];
for(const id of (await eda.pcb_PrimitivePad.getAllPrimitiveId())){
  const p=await eda.pcb_PrimitivePad.get(id);
  pads.push({net:p?.getState_Net?.(),x:p?.getState_X?.(),y:p?.getState_Y?.(),
    w:p?.getState_Width?.(),h:p?.getState_Height?.(),shape:p?.getState_Shape?.(),
    layer:p?.getState_Layer?.(),num:p?.getState_Number?.()});
}
L.push({pads});
return L;
