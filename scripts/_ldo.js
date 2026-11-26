const L=[];
for(const c of ['C6186','C2297']){
  try{
    const r=await eda.lib_Device.getByLcscIds([c]);
    const d=Array.isArray(r)?r[0]:(r?.lists?.[0]||r?.value?.[0]);
    L.push({lcsc:c, name:d.name, symbolName:d.symbolName, footprintName:d.footprintName,
      symUuid:d.symbolUuid, fpuuid:d.footprintUuid,
      desc:String(d.description||'').slice(0,200),
      other:d.otherProperty});
    // 引脚定义
    const g=await eda.lib_Symbol.getGeometry(d.symbolUuid, d.libraryUuid);
    if(g?.ok){
      L.push({pins:(g.value.pins||[]).map(p=>({n:p.pinNumber,name:p.pinName,side:p.side,x:p.x,y:p.y}))});
    } else L.push({geoErr:String(g)});
  }catch(e){ L.push({lcsc:c,err:String(e&&e.message).slice(0,200)}); }
}
return L;
