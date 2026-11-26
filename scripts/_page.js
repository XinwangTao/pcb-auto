const A=__CLI__.args; const L=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await eda.dmt_Project.openProject(A.proj);
await sleep(2500); await eda.dmt_Project.waitForReady(A.proj,60000);
const b=(await eda.dmt_Board.getAllBoardsInfo())[0];
const pageUuid=b.schematic.page[0].uuid;
await eda.dmt_EditorControl.openDocument(pageUuid);
await eda.dmt_EditorControl.waitForDocumentReady(pageUuid,120000);
await sleep(1500);
try{ L.push({pageInfo: JSON.stringify(await eda.sch_Document.getPageInfo?.() || null)}); }catch(e){ L.push({e1:String(e&&e.message).slice(0,150)}); }
try{ L.push({docInfo: JSON.stringify(await eda.sch_Document.getDocumentInfo?.() || null).slice(0,800)}); }catch(e){ L.push({e2:String(e&&e.message).slice(0,150)}); }
// 图页边界/纸型
for(const fn of ['getPageSize','getSheetSize','getCanvasSize','getPageSetting','getDocumentSetting']){
  try{ if(typeof eda.sch_Document[fn]==='function'){ const r=await eda.sch_Document[fn](); L.push({[fn]: JSON.stringify(r).slice(0,400)}); } }catch(e){}
}
// 器件实际位置
const comps=[];
for(const id of await eda.sch_PrimitiveComponent.getAllPrimitiveId()){
  const c=await eda.sch_PrimitiveComponent.get(id);
  comps.push({des:c?.getState_Designator?.(), x:c?.getState_X?.(), y:c?.getState_Y?.()});
}
L.push({comps});
return L;
