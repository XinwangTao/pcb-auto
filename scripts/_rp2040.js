const A=__CLI__.args; const L=[];
const r=await eda.lib_Device.getByLcscIds(['C2040']);
const d=Array.isArray(r)?r[0]:(r?.lists?.[0]||r?.value?.[0]);
L.push({name:d.name, fp:d.footprintName, sym:d.symbolUuid, lib:d.libraryUuid, fpu:d.footprintUuid});
// 引脚清单
try{
  const g=await eda.lib_Symbol.getGeometry(d.symbolUuid, d.libraryUuid);
  if(g?.ok && Array.isArray(g.value)){
    L.push({pins:g.value.map(p=>({n:p.pinNumber, name:p.pinName, side:p.side}))});
  } else L.push({geoRaw:JSON.stringify(g).slice(0,500)});
}catch(e){ L.push({geoErr:String(e&&e.message).slice(0,200)}); }
return L;
