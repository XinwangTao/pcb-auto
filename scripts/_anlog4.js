const fs=require('fs');
const j=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
console.log('ok='+j.ok+' entries='+j.entries.length);
const pick=k=>j.entries.filter(e=>e.s===k);
for(const k of ['snappedLines','drcLeafCount','drcCheck','patchTotal','clearanceFixes','patchRound','patchNoProgress','route','layout']){
  for(const e of pick(k).slice(0,3)) console.log('  '+k+' => '+JSON.stringify(e.v).slice(0,300));
}
const errs=j.entries.filter(e=>e.s==='errors'||e.s==='netMismatches'||e.s==='warns');
for(const e of errs) console.log('  '+e.s+' => '+JSON.stringify(e.v).slice(0,400));