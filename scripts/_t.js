const L=[];
async function tryName(n){
  try{ const u=await eda.dmt_Project.createProject(n,null,null,null,"x"); L.push({n,ok:true,u}); }
  catch(e){ L.push({n,ok:false,e:String(e&&e.message)}); }
}
await tryName("AI_SHT30_TempHumidity");
await tryName("AI_SHT30_TempHumidity");
await tryName("AI_UNIQUE_"+Date.now());
// 列现有工程
try{ const ps=await eda.dmt_Project.getAllProjects(); L.push({count:Array.isArray(ps)?ps.length:null,names:(ps||[]).slice(0,15).map(p=>p.friendlyName||p.name)}); }
catch(e){ L.push({listErr:String(e&&e.message)}); }
return L;
