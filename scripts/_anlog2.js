const fs=require('fs');
const j=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
for(const k of ['patchPairSynth','patchIslandPair','connDiag','patchNoProgress']){
  console.log('  --- '+k+' ---');
  for(const e of j.entries.filter(x=>x.s===k)) console.log('    '+JSON.stringify(e.v));
}
console.log('  --- 全部键名 ---');
console.log('    '+[...new Set(j.entries.map(e=>e.s))].sort().join(' '));