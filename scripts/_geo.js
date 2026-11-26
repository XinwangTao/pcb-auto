const A=__CLI__.args;
const d=(await eda.lib_Device.getByLcscIds([A.lcsc]))[0];
const g=await eda.lib_Symbol.getGeometry(d.symbolUuid,d.libraryUuid);
return {lcsc:A.lcsc,name:d.name,symbolUuid:d.symbolUuid,libraryUuid:d.libraryUuid,
  bodyBBox:g?.bodyBBox,fullBBox:g?.fullBBox,
  pins:(g?.pins||[]).map(p=>({n:p.pinNumber,name:p.pinName,x:p.x,y:p.y,side:p.side}))};
