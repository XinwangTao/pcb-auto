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
// 只提取 Via Size / Track 相关
const out={keys:Object.keys(c)};
if(c.Physics) out.physicsKeys=Object.keys(c.Physics);
if(c.Physics?.Via) out.via=JSON.stringify(c.Physics.Via).slice(0,2000);
if(c.Physics?.Track) out.track=JSON.stringify(c.Physics.Track).slice(0,1500);
out.manufacturing = c.Manufacturing ? JSON.stringify(c.Manufacturing).slice(0,3000) : null;
return out;
