const A=__CLI__.args;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await eda.dmt_Project.openProject(A.proj);
await sleep(2000); await eda.dmt_Project.waitForReady(A.proj,60000);
const b=(await eda.dmt_Board.getAllBoardsInfo())[0];
await eda.dmt_EditorControl.openDocument(b.pcb.uuid);
await eda.dmt_EditorControl.waitForDocumentReady(b.pcb.uuid,120000);
await sleep(1500);
const cfg=await eda.pcb_Drc.getCurrentRuleConfiguration();
const c=cfg?.config||{};
return {
  viaSize: JSON.stringify(c.Physics?.['Via Size']),
  drillHole: JSON.stringify(c['Drill Hole Analysis']).slice(0,2000),
  plane: JSON.stringify(c.Plane).slice(0,1500),
  expansion: JSON.stringify(c.Expansion).slice(0,1200),
};
