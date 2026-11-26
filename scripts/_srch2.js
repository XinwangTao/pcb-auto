const A=__CLI__.args; const L=[];
try{
  const r=await eda.lib_Device.search('AHT20', 1, 5);
  L.push({type:typeof r, keys:r&&Object.keys(r), sample:JSON.stringify(r).slice(0,1200)});
}catch(e){ L.push({err:String(e&&e.message).slice(0,300), stack:String(e&&e.stack).slice(0,300)}); }
return L;
