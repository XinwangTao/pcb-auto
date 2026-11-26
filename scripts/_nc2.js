const A=__CLI__.args; const L=[];
L.push({has: typeof eda.sch_SourcePin?.setNoConnect});
L.push({fnLen: eda.sch_SourcePin?.setNoConnect?.length, src:String(eda.sch_SourcePin?.setNoConnect).slice(0,400)});
const base={ projectId:A.proj, schematicName:'Schematic1', pageName:'P1', primitiveId:'68df0518811c9f7f' };
const variants={
  v1:{ ...base, pinNumber:'1', noConnect:true },
  v2:{ ...base, pinNumbers:['1'], noConnect:true },
  v3:{ ...base, pinId:'1', noConnect:true },
  v4:{ ...base, pinNumber:'1', isNoConnect:true },
  v5:{ ...base, pins:['1'], noConnect:true },
};
for(const [k,v] of Object.entries(variants)){
  try{ const r=await eda.sch_SourcePin.setNoConnect(v); L.push({k,ok:true,r:JSON.stringify(r).slice(0,250)}); }
  catch(e){ L.push({k,err:String(e&&e.message).slice(0,180)}); }
}
return L;
