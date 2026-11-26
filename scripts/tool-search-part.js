// 选料搜索器：按关键词搜，过滤出真正想要的器件
// 因为 search 质量差，必须用 footprint + description 做硬过滤
const A = __CLI__.args;
const kw = A.kw;
const mustFootprint = (A.footprint || '').toLowerCase();
const mustDescHas = (A.descHas || '').toLowerCase();
const limit = A.limit || 20;

const res = await eda.lib_Device.search(kw, undefined, undefined, undefined, limit, 1);
const out = { kw, raw: (res || []).length, accepted: [], rejected: [] };
for (const d of (res || [])) {
  const p = d.otherProperty || {};
  const fp = String(p['Supplier Footprint'] || '').toLowerCase();
  const desc = String(d.description || '').toLowerCase();
  const item = {
    lcsc: p['Supplier Part'],
    name: d.name,
    klass: p['JLCPCB Part Class'],
    footprint: p['Supplier Footprint'],
    value: p.Value,
    desc: d.description,
    symbolUuid: d.symbolUuid,
    footprintUuid: d.footprintUuid,
    libraryUuid: d.libraryUuid,
  };
  const fpOk = !mustFootprint || fp.includes(mustFootprint);
  const descOk = !mustDescHas || desc.includes(mustDescHas);
  if (fpOk && descOk) out.accepted.push(item);
  else out.rejected.push({ lcsc: item.lcsc, footprint: item.footprint, desc: (item.desc || '').slice(0, 40) });
}
return out;
