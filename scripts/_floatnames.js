const fs=require('fs'),path=require('path');const root=path.join(__dirname,'..');
const cat=JSON.parse(fs.readFileSync(path.join(root,'designs','_catalog.json'),'utf8'));
const byLcsc=new Map(cat.parts.map(p=>[String(p.lcsc),p]));
function expandPins(v){const out=new Set();const walk=x=>{if(x==null)return;if(Array.isArray(x))return x.forEach(walk);if(typeof x==='object')return Object.values(x).forEach(walk);String(x).split(/[\s,]+/).filter(Boolean).forEach(t=>out.add(t));};walk(v);return [...out];}
for(const f of ['d1-sht30.json','d11-crystal-rtc.json','d7-rp2040-flash.json','d13-solar-oled-logger.json','d2-sht30-module.json']){
  const d=JSON.parse(fs.readFileSync(path.join(root,'designs',f),'utf8'));
  const used=new Map();
  for(const t of d.connections||[]){if(!Array.isArray(t)||t.length<3)continue;const[des,pin]=t;if(!used.has(des))used.set(des,new Set());used.get(des).add(String(pin));}
  for(const c of d.components||[]){
    const m=byLcsc.get(String(c.lcsc));if(!m||!m.pins)continue;
    const named=m.pins, all=expandPins(m.pins), u=used.get(c.des)||new Set();
    const floatPinNames=Object.entries(named).filter(([nm,v])=>expandPins(v).every(p=>!u.has(p))).map(([nm])=>nm);
    if(!floatPinNames.length)continue;
    console.log(`\n${f}  ${c.des}=${m.name}`);
    console.log(`  悬空脚名: ${floatPinNames.join(', ')}`);
  }
}
