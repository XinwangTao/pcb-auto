const L=[];
const A=__CLI__.args;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await eda.dmt_Project.openProject(A.proj);
await sleep(2000); await eda.dmt_Project.waitForReady(A.proj,60000);
const b=(await eda.dmt_Board.getAllBoardsInfo())[0];
await eda.dmt_EditorControl.openDocument(b.pcb.uuid);
await eda.dmt_EditorControl.waitForDocumentReady(b.pcb.uuid,120000);
await sleep(1500);
// 查当前规则配置
try{ const cfg=await eda.pcb_Drc.getCurrentRuleConfiguration(); L.push({ruleCfg:cfg}); }catch(e){ L.push({e1:String(e&&e.message)}); }
// 查 net 规则
try{ const nr=await eda.pcb_Drc.getNetRules(); L.push({netRules:nr}); }catch(e){ L.push({e2:String(e&&e.message)}); }
// 查 via 图元
try{ const ids=await eda.pcb_PrimitiveVia.getAllPrimitiveId(); L.push({viaIds:ids});
  for(const id of ids){ const v=await eda.pcb_PrimitiveVia.get(id);
    L.push({via:{net:v?.getState_Net?.(),d:v?.getState_Diameter?.(),h:v?.getState_HoleDiameter?.(),x:v?.getState_X?.(),y:v?.getState_Y?.()}}); }
}catch(e){ L.push({e3:String(e&&e.message)}); }
return L;
