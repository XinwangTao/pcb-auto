const fs=require('fs');
const s=fs.readFileSync(process.argv[2],'utf8');
console.log('  trackDoglegRolledBack 次数: '+(s.split('trackDoglegRolledBack').length-1));
console.log('  trackRerouteRolledBack 次数: '+(s.split('trackRerouteRolledBack').length-1));
// 打印 P5/P6 附近原文，带可见空白
const lines=s.split('\n');
for(const n of [1826,1827,1828,1829,1830,1831,1832,1833,1834]){
  console.log('  L'+n+'|'+JSON.stringify(lines[n-1]));
}