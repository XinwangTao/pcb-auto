const fs=require('fs');
const src=fs.readFileSync(process.argv[2],'utf8');
const a=src.indexOf("phase('snapEnds');");
const endMark="} catch (e) { log('snapFail', String(e && e.message).slice(0, 150)); }";
const b=src.indexOf(endMark,a);
const block=src.slice(a,b+endMark.length);
const body='(async()=>{'+block+'\n})()';
console.log('  body 尾 60: '+JSON.stringify(body.slice(-60)));
const fn=new Function('eda','log','sleep','left','phase',body);
const line={id:'X',net:'3V3',sx:1226.7068841582823,sy:-1018.9274119191974,ex:1226.6968841836824,ey:-1018.9274119191974};
const via={id:'V',net:'3V3',x:1226.7005,y:-1018.9274119191974};
const eda={
  pcb_PrimitivePad:{getAllPrimitiveId:async()=>[],get:async()=>null},
  pcb_PrimitiveVia:{getAllPrimitiveId:async()=>['V'],get:async()=>({getState_Net:()=>via.net,getState_X:()=>via.x,getState_Y:()=>via.y})},
  pcb_PrimitiveLine:{getAllPrimitiveId:async()=>['X'],
    get:async()=>({getState_Net:()=>line.net,getState_StartX:()=>line.sx,getState_StartY:()=>line.sy,getState_EndX:()=>line.ex,getState_EndY:()=>line.ey}),
    modify:async()=>{}, delete:async(id)=>{}},
};
const logs=[];
const ret = fn(eda,(k,v)=>logs.push({k,v}),async()=>{},()=>600000,()=>{});
console.log('  返回类型: '+(ret&&typeof ret.then==='function'?'thenable':String(ret)));
(async()=>{
  try { const r = await ret; console.log('  await 完成 r='+String(r)); }
  catch(e){ console.log('  抛出: '+e.constructor.name+': '+e.message); }
  console.log('  logs='+JSON.stringify(logs));
})();