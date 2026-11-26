// 精确区分：真实 LCSC 编号 vs 社区伪编号
// 真实：C + 1..8 位数字（如 C14663, C86346, C2286）
// 社区伪编号：C99 + 7 位（总长 10，如 C9900008394）—— 但也可能是真实的大编号
// 关键判据：看 otherProperty['Supplier'] 是否 LCSC + 是否有完整 datasheet / Manufacturer
const A = __CLI__.args;
const ids = A.ids || [];
const devs = await eda.lib_Device.getByLcscIds(ids);
return (devs || []).map(d => {
  const p = d.otherProperty || {};
  return {
    lcsc: p['Supplier Part'],
    name: d.name,
    klass: p['JLCPCB Part Class'],
    supplier: p['Supplier'],
    footprint: p['Supplier Footprint'],
    mfr: p['Manufacturer'],
    mfrPart: p['Manufacturer Part'],
    datasheet: (p['Datasheet'] || '').slice(0, 60),
    value: p.Value,
    desc: String(d.description || '').slice(0, 70),
    hasSymbol: !!d.symbolUuid,
    hasFootprint: !!d.footprintUuid,
    symbolUuid: d.symbolUuid,
    footprintUuid: d.footprintUuid,
    libraryUuid: d.libraryUuid,
  };
});
