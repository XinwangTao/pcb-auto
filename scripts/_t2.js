const L=[];
for(let i=0;i<4;i++){
  const n="PROBE_"+(1000+i)+"_"+Math.random().toString(36).slice(2,6);
  try{ const u=await eda.dmt_Project.createProject(n,null,null,null,"x"); L.push({i,n,type:typeof u,u:String(u)}); }
  catch(e){ L.push({i,err:String(e&&e.message)}); }
}
return L;
