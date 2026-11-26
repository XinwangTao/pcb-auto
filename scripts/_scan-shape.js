const fs=require('fs'),path=require('path');
const root=process.argv[2];
const pick=['RP2040_QSPI_Flash-20261125-221908','RP2040_QSPI_Flash-20261125-215630','Crystal_RTC_Clock-20261125-223205','SHT30_I2C_TempHumidity-20261125-222351','ESP32C3_Minimal-20261125-222732'];
for(const d of pick){
  const p=path.join(root,'out',d,'_run.json');
  if(!fs.existsSync(p)){console.log(d+' -> 无 _run.json');continue}
  const j=JSON.parse(fs.readFileSync(p,'utf8'));
  console.log('\n### '+d+'  ('+fs.statSync(p).size+' B)');
  console.log('  顶层键: '+Object.keys(j).join(', '));
  if(j.value&&typeof j.value==='object') console.log('  value 键: '+Object.keys(j.value).slice(0,40).join(', '));
  for(const k of ['ok','drcPassed','drcLeafCount','layoutState','routeState','patchTotal','exports','artifacts','errors','elapsedMs']){
    const tgt=(j[k]!==undefined)?j:(j.value||{});
    if(tgt[k]!==undefined){
      const v=tgt[k];
      console.log('   '+k+' = '+(Array.isArray(v)?('[数组 '+v.length+']'):(typeof v==='object'?JSON.stringify(v).slice(0,90):v)));
    }
  }
}