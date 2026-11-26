const fs=require('fs');
const src=fs.readFileSync(process.argv[2],'utf8');
const a=src.indexOf('      const parseValue = (s) => {');
const b=src.indexOf('    r = await eda.sch_SourcePrimitiveComponent.add({');
const block=src.slice(a,b).replace(/\s+$/,'');
console.log('  a='+a+' b='+b);
console.log('  块行数='+block.split('\n').length);
console.log('  块尾300字符:');
console.log(JSON.stringify(block.slice(-300)));
// 花括号平衡
let d=0; for(const ch of block){ if(ch==='{')d++; else if(ch==='}')d--; }
console.log('  花括号净差='+d+'（0=平衡）');