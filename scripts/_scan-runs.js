const fs=require('fs'),path=require('path');
const root=process.argv[2];
const outDir=path.join(root,'out');
const dirs=fs.readdirSync(outDir,{withFileTypes:true}).filter(d=>d.isDirectory()&&d.name!=='frames'&&d.name!=='covers').map(d=>d.name);
const rows=[];
for(const d of dirs){
  const p=path.join(outDir,d,'_run.json');
  if(!fs.existsSync(p))continue;
  let j;try{j=JSON.parse(fs.readFileSync(p,'utf8'))}catch(e){rows.push({d,parse:'FAIL'});continue}
  const v=j.value||j;
  rows.push({
    d,
    ok: v.ok===true,
    drc: v.drcPassed,
    drcLeaf: v.drcLeafCount, drcTotal: v.drcTotalCount,
    layout: v.layoutState, route: v.routeState,
    patch: v.patchTotal,
    exp: Array.isArray(v.exports)?v.exports.filter(e=>e&&e.ok===true).length:null,
    art: Array.isArray(v.artifacts)?v.artifacts.length:null,
    err: Array.isArray(v.errors)?v.errors.slice(0,2):null,
    ms: v.elapsedMs,
  });
}
rows.sort((a,b)=>String(a.d).localeCompare(String(b.d)));
console.log('目录'.padEnd(34)+'ok   DRC  叶/总   layout   route     patch exp art   耗时');
for(const r of rows){
  console.log(
    String(r.d).padEnd(34)+
    String(r.ok===true?'Y':'n').padEnd(5)+
    String(r.drc===true?'Y':(r.drc===false?'N':'?')).padEnd(6)+
    String((r.drcLeaf??'?')+'/'+(r.drcTotal??'?')).padEnd(7)+
    String(r.layout??'?').padEnd(9)+
    String(r.route??'?').padEnd(10)+
    String(r.patch??'?').padEnd(6)+
    String(r.exp??'?').padEnd(4)+
    String(r.art??'?').padEnd(6)+
    String(r.ms?Math.round(r.ms/1000)+'s':'?')
  );
}
console.log('\n合计 '+rows.length+' 份 _run.json，ok=true 的 '+rows.filter(r=>r.ok===true).length+' 份');
console.log('\n=== 失败样本的首条错误 ===');
for(const r of rows.filter(x=>x.ok!==true)) if(r.err&&r.err.length) console.log('  '+String(r.d).slice(0,30).padEnd(32)+' '+JSON.stringify(r.err[0]).slice(0,140));