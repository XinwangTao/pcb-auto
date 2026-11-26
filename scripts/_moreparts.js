const A=__CLI__.args; const L=[];
// 试一批常见基础件的 LCSC 号，找出真实可用的多引脚 IC
const cands=['C2040','C27920','C3588','C2977920','C90872','C2843303','C76256','C194366','C5335236','C2827625'];
for(const c of cands){
  try{
    const r=await eda.lib_Device.getByLcscIds([c]);
    const d=Array.isArray(r)?r[0]:(r?.lists?.[0]||r?.value?.[0]);
    if(!d){ L.push({c, nf:1}); continue; }
    const o=d.otherProperty||{};
    L.push({lcsc:c, name:d.name, fp:d.footprintName, cls:o['JLCPCB Part Class'],
      mfr:o['Manufacturer'], ds:o['Datasheet']?1:0,
      sym:d.symbolUuid, lib:d.libraryUuid,
      desc:String(d.description||'').slice(0,80)});
  }catch(e){ L.push({c, err:String(e&&e.message).slice(0,80)}); }
}
return L;
