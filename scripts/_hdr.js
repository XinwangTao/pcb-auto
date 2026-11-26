const A=__CLI__.args; const L=[];
const syms={ 'C20610231':'867e088a64c14787b4ef668a6d1dcbe4', 'C86346':null };
for(const c of A.ids){
  const r=await eda.lib_Device.getByLcscIds([c]);
  const d=Array.isArray(r)?r[0]:(r?.lists?.[0]||r?.value?.[0]);
  if(!d) continue;
  L.push({lcsc:c, name:d.name, fp:d.footprintName, sym:d.symbolUuid, lib:d.libraryUuid,
    desc:String(d.description||'').slice(0,120)});
}
return L;
