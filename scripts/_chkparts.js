const A=__CLI__.args; const L=[];
for(const c of A.ids){
  try{
    const r=await eda.lib_Device.getByLcscIds([c]);
    const d=Array.isArray(r)?r[0]:(r?.lists?.[0]||r?.value?.[0]);
    if(!d){ L.push({lcsc:c,notfound:true}); continue; }
    const o=d.otherProperty||{};
    L.push({lcsc:c, name:d.name, fp:d.footprintName,
      mfr:o['Manufacturer'], cls:o['JLCPCB Part Class'],
      ds:o['Datasheet']?true:false, sym:d.symbolUuid, lib:d.libraryUuid,
      desc:String(d.description||'').slice(0,90)});
  }catch(e){ L.push({lcsc:c,err:String(e&&e.message).slice(0,120)}); }
}
return L;
