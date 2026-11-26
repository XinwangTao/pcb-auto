const fs=require('fs');
const src=fs.readFileSync(process.argv[2],'utf8');
const a0=src.indexOf("phase('snapEnds');");
const aC=src.lastIndexOf('// ---------- 8.2 走线端点吸附 ----------',a0);
const a=aC>=0?aC:a0;
const endMark="} catch (e) { log('snapFail', String(e && e.message).slice(0, 150)); }";
const b=src.indexOf(endMark,a);
const block=src.slice(a,b+endMark.length);
console.log('  a='+a+' b='+b+' len='+block.length);
console.log('  头 200: '+JSON.stringify(block.slice(0,200)));
console.log('  尾 150: '+JSON.stringify(block.slice(-150)));
const fn=new Function('eda','log','sleep','left','phase','(async()=>{'+block+'\n})()');
const logs=[];
const line={id:'X',net:'3V3',sx:1226.7068841582823,sy:-1018.9274119191974,ex:1226.6968841836824,ey:-1018.9274119191974};
const via={id:'V',net:'3V3',x:1226.7005,y:-1018.9274119191974};
const eda={
  pcb_PrimitivePad:{getAllPrimitiveId:async()=>[],get:async()=>null},
  pcb_PrimitiveVia:{getAllPrimitiveId:async()=>['V'],get:async(id)=>({getState_Net:()=>via.net,getState_X:()=>via.x,getState_Y:()=>via.y})},
  pcb_PrimitiveLine:{getAllPrimitiveId:async()=>['X'],
    get:async(id)=>({getState_Net:()=>line.net,getState_StartX:()=>line.sx,getState_StartY:()=>line.sy,getState_EndX:()=>line.ex,getState_EndY:()=>line.ey}),
    modify:async(id,o)=>console.log('  MODIFY '+id+' '+JSON.stringify(o)), delete:async(id)=>console.log('  DELETE '+id)},
};
(async()=>{
  try { await fn(eda,(k,v)=>logs.push({k,v}),async()=>{},()=>600000,()=>{}); }
  catch(e){ console.log('  抛出: '+e.message); }
  console.log('  logs='+JSON.stringify(logs));
})();