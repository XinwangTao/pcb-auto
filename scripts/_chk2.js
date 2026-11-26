const L=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await eda.dmt_EditorControl.openDocument("e29964feab1c0b94");
await eda.dmt_EditorControl.waitForDocumentReady("e29964feab1c0b94",120000);
await sleep(1500);
const ids=await eda.pcb_PrimitiveLine.getAllPrimitiveId();
for(const id of ids){
  try{
    const l=await eda.pcb_PrimitiveLine.get(id);
    L.push({id, net:l?.getState_Net?.(), layer:l?.getState_Layer?.(),
      start:l?.getState_StartPoint?.(), end:l?.getState_EndPoint?.(),
      width:String(l?.getState_LineWidth?.())});
  }catch(e){ L.push({id,err:String(e&&e.message).slice(0,60)}); }
}
// pads
const pads=await eda.pcb_PrimitivePad.getAllPrimitiveId();
for(const id of pads){
  try{
    const p=await eda.pcb_PrimitivePad.get(id);
    L.push({pad:id, net:p?.getState_Net?.(), layer:p?.getState_Layer?.(),
      x:p?.getState_X?.(), y:p?.getState_Y?.(), num:p?.getState_Number?.()});
  }catch(e){ L.push({pad:id,err:String(e&&e.message).slice(0,60)}); }
}
return L;
