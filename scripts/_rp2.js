const L=[];
const r=await eda.lib_Device.getByLcscIds(['C2040']);
const d=Array.isArray(r)?r[0]:(r?.lists?.[0]||r?.value?.[0]);
const g=await eda.lib_Symbol.getGeometry(d.symbolUuid, d.libraryUuid);
const pins=g.value;
const out=[];
for(const p of pins){ out.push(p.pinNumber+'|'+p.pinName+'|'+p.side); }
return {total:pins.length, pins:out};
