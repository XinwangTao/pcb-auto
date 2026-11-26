// 选料验证器：给定 LCSC 编号，验证它到底是什么器件
// 核心教训：LCSC 编号绝不能猜，必须验证 footprint / 类别 / 描述
const A = __CLI__.args;
const ids = A.ids || [];
const devs = await eda.lib_Device.getByLcscIds(ids);
const out = [];
for (const d of (devs || [])) {
  const p = d.otherProperty || {};
  out.push({
    lcsc: p['Supplier Part'],
    name: d.name,
    klass: p['JLCPCB Part Class'],       // Basic Part / Extended Part
    footprint: p['Supplier Footprint'],  // 0402 / 0603 / SOT-223 ...
    value: p.Value,
    desc: d.description,
    mfrPart: p['Manufacturer Part'],
    symbolUuid: d.symbolUuid,
    footprintUuid: d.footprintUuid,
    libraryUuid: d.libraryUuid,
  });
}
return out;
