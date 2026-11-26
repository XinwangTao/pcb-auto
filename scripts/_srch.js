const A=__CLI__.args; const L=[];
async function srch(q, n){
  try{
    const r=await eda.lib_Device.search(q, 1, n||8);
    const list=r?.lists||r?.value?.lists||(Array.isArray(r)?r:[]);
    L.push({q, count:list.length, items:list.slice(0,8).map(d=>({
      lcsc: d.otherProperty?.['Supplier Part'] || d.lcsc,
      name: d.name,
      mfr: d.otherProperty?.['Manufacturer'],
      cls: d.otherProperty?.['JLCPCB Part Class'],
      fp: d.footprintName,
    }))});
  }catch(e){ L.push({q, err:String(e&&e.message).slice(0,150)}); }
}
for(const q of A.qs){ await srch(q, 8); }
return L;
