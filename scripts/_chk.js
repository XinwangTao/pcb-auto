const A=__CLI__.args;
const L=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// 找最近的工程
const p=await eda.dmt_Project.openProject(A.u);
await sleep(2000); await eda.dmt_Project.waitForReady(A.u,60000);
const b=(await eda.dmt_Board.getAllBoardsInfo())[0];
await eda.dmt_EditorControl.openDocument(b.pcb.uuid);
await eda.dmt_EditorControl.waitForDocumentReady(b.pcb.uuid,120000);
await sleep(1500);
for(const cls of ['pcb_PrimitiveLine','pcb_PrimitiveArc','pcb_PrimitiveVia','pcb_PrimitivePad','pcb_PrimitiveComponent','pcb_PrimitiveFill','pcb_PrimitiveRegion']){
  try{ const ids=await eda[cls].getAllPrimitiveId(); L.push({cls,n:Array.isArray(ids)?ids.length:null}); }
  catch(e){ L.push({cls,err:String(e&&e.message).slice(0,80)}); }
}
// 网络长度
try{
  const names=await eda.pcb_Net.getAllNetsName();
  const lens=[];
  for(const n of names){ try{ lens.push({n,len:await eda.pcb_Net.getNetLength(n)}); }catch(e){} }
  L.push({nets:names,lens});
}catch(e){ L.push({netErr:String(e&&e.message)}); }
// 板框
try{
  const bb=await eda.pcb_Primitive.getPrimitivesBBox();
  L.push({bbox:bb});
}catch(e){ L.push({bboxErr:String(e&&e.message)}); }
return L;
