const A=__CLI__.args; const L=[];
// 探测 setNoConnect 的签名：用函数 length + 逐个变体试探
L.push({fnLen: eda.SCH_SourcePin.setNoConnect.length, str: String(eda.SCH_SourcePin.setNoConnect).slice(0,300)});
const base={ projectId:A.proj, schematicName:'Schematic1', pageName:'P1', primitiveId:'68df0518811c9f7f' };
const variants=[
  { ...base, pinNumber:'1', noConnect:true },
  { ...base, pinNumbers:['1'], noConnect:true },
  { ...base, pinId:'1', noConnect:true },
  { ...base, pinNumber:'1', isNoConnect:true },
  { ...base, pins:['1'], noConnect:true },
];
for(let i=0;i<variants.length;i++){
  try{ const r=await eda.SCH_SourcePin.setNoConnect(variants[i]); L.push({i,ok:true,r:JSON.stringify(r).slice(0,300)}); }
  catch(e){ L.push({i,err:String(e&&e.message).slice(0,200)}); }
}
return L;
