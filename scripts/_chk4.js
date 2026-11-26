const L=[];
const A=__CLI__.args;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await eda.dmt_Project.openProject(A.proj);
await sleep(2500); await eda.dmt_Project.waitForReady(A.proj,60000);
const b=(await eda.dmt_Board.getAllBoardsInfo())[0];
await eda.dmt_EditorControl.openDocument(b.pcb.uuid);
await eda.dmt_EditorControl.waitForDocumentReady(b.pcb.uuid,120000);
await sleep(2000);
for(const cls of ['pcb_PrimitiveLine','pcb_PrimitiveVia','pcb_PrimitivePad','pcb_PrimitiveFill','pcb_PrimitiveRegion']){
  try{ const ids=await eda[cls].getAllPrimitiveId(); L.push({cls,n:Array.isArray(ids)?ids.length:null}); }
  catch(e){ L.push({cls,err:String(e&&e.message).slice(0,60)}); }
}
try{
  const ids=await eda.pcb_PrimitivePad.getAllPrimitiveId();
  const pads=[];
  for(const id of ids){ const p=await eda.pcb_PrimitivePad.get(id);
    pads.push({net:p?.getState_Net?.(),x:p?.getState_X?.(),y:p?.getState_Y?.(),num:p?.getState_Number?.()}); }
  L.push({pads});
}catch(e){ L.push({padErr:String(e&&e.message)}); }
try{
  const n=await eda.pcb_Net.getAllNetsName();
  const lens=[]; for(const x of n){ try{lens.push({n:x,len:await eda.pcb_Net.getNetLength(x)});}catch(e){} }
  L.push({lens});
}catch(e){}
return L;
