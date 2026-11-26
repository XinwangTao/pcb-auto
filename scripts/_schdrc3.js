const A=__CLI__.args; const L=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await eda.dmt_Project.openProject(A.proj);
await sleep(2500); await eda.dmt_Project.waitForReady(A.proj,60000);
const b=(await eda.dmt_Board.getAllBoardsInfo())[0];
const pageUuid=b.schematic.page[0].uuid;
await eda.dmt_EditorControl.openDocument(pageUuid);
await eda.dmt_EditorControl.waitForDocumentReady(pageUuid,120000);
await sleep(2500);
try{ const passed=await eda.sch_Drc.check(true,false,false); L.push({drcPassed:passed}); }
catch(e){ L.push({e1:String(e&&e.message).slice(0,250)}); }
try{ const r=await eda.sch_Drc.check(true,false,true); L.push({drcTree:JSON.stringify(r).slice(0,6000)}); }
catch(e){ L.push({e2:String(e&&e.message).slice(0,250)}); }
return L;
