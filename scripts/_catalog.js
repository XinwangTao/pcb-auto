const L=[];
// 核实一批常用/常见器件，为"想法->设计"目录建库
const cands=[
 ['C86346','SHT30'],['C6186','AMS1117-3.3'],['C2297','LED-0805-G'],['C14663','100nF-0603'],
 ['C440198','10uF-0805'],['C11702','1k-0603'],['C25905','5.1k-0603'],['C1525','100nF-0402'],
 ['C2040','RP2040'],['C9900192758','Header-8P'],['C20610231','Header-22P'],
 ['C27920','8.2nF-0603'],['C2843303','SL9305-IR'],['C2827625','TPNSQA6V8-TV']
];
for(const [c,tag] of cands){
  try{
    const r=await eda.lib_Device.getByLcscIds([c]);
    const d=Array.isArray(r)?r[0]:(r?.lists?.[0]||r?.value?.[0]);
    if(!d){ L.push(tag+'|'+c+'|MISSING'); continue; }
    const o=d.otherProperty||{};
    L.push([tag,c,d.name,o['JLCPCB Part Class']||'',(o['Manufacturer']||'')?1:0,(o['Datasheet']||'')?1:0,
      d.footprintName||'',d.symbolName||'',o['Designator']||''].join('|'));
  }catch(e){ L.push(tag+'|'+c+'|ERR:'+String(e&&e.message).slice(0,40)); }
}
return L;
