const A=__CLI__.args; const L=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await eda.dmt_Project.openProject(A.proj);
await sleep(2500); await eda.dmt_Project.waitForReady(A.proj,60000);
const b=(await eda.dmt_Board.getAllBoardsInfo())[0];
await eda.dmt_EditorControl.openDocument(b.sch.uuid || b.schematic.uuid);
await eda.dmt_EditorControl.waitForDocumentReady(b.sch.uuid || b.schematic.uuid,120000);
await sleep(2000);
// SCH DRC
try{
  const r=await eda.sch_Drc.check(true,false,true);
  L.push({drcTree: JSON.stringify(r).slice(0,4000)});
}catch(e){ L.push({drcErr:String(e&&e.message).slice(0,300)}); }
try{
  const passed=await eda.sch_Drc.check(true,false,false);
  L.push({drcPassed:passed});
}catch(e){ L.push({drcPassedErr:String(e&&e.message).slice(0,300)}); }
return L;
