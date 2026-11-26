const A=__CLI__.args; const L=[];
// 4 个焊盘的方向：1 3V3 2 GND 3 SDA 4 SCL
for(const c of ['C9900095162','C9900192758']){
  try{
    const r=await eda.lib_Device.getByLcscIds([c]);
    const d=Array.isArray(r)?r[0]:(r?.lists?.[0]||r?.value?.[0]);
    if(!d){ L.push({c,notfound:true}); continue; }
    L.push({lcsc:c, name:d.name, fp:d.footprintName, fpUuid:d.footprintUuid,
      sym:d.symbolUuid, lib:d.libraryUuid,
      desc:String(d.description||'').slice(0,150),
      other: Object.fromEntries(Object.entries(d.otherProperty||{}).filter(([k])=>!['Symbol','Footprint','LCSC Part Name'].includes(k)).slice(0,12))});
    // footprint 尺寸
    try{
      const fg=await eda.lib_Footprint.getGeometry?.(d.footprintUuid, d.libraryUuid);
      if(fg?.ok) L.push({fpGeo: JSON.stringify(fg.value).slice(0,600)});
    }catch(e){}
  }catch(e){ L.push({c,err:String(e&&e.message).slice(0,150)}); }
}
return L;
