// 自动选料器：搜索 → 严格过滤 → 打分 → 返回最优
// 教训：search 质量差，必须用 footprint + value + desc 三重硬过滤
const A = __CLI__.args;
const spec = A.spec;   // { kw, footprint, value, kind, preferBasic }
const limit = A.limit || 20;

function norm(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/Ω|OHM/g, 'R')
    .replace(/μ|µ/g, 'U');
}

const res = await eda.lib_Device.search(spec.kw, undefined, undefined, undefined, limit, 1);
const cands = [];

for (const d of (res || [])) {
  const p = d.otherProperty || {};
  const lcsc = p['Supplier Part'];
  const klass = p['JLCPCB Part Class'] || '';
  const fp = String(p['Supplier Footprint'] || '');
  const value = String(p.Value || '');
  const desc = String(d.description || '');
  const name = String(d.name || '');
  const mfr = String(p['Manufacturer Part'] || '');

  // 伪编号（社区/用户库）直接剔除
  if (/^C99\d{7}$/.test(lcsc)) continue;
  if (!klass) continue;          // 无 JLCPCB 分类 = 不可采购，剔除

  const nfp = norm(fp);
  const nval = norm(value);
  const ndesc = norm(desc);
  const nname = norm(name);
  const nmfr = norm(mfr);

  // --- 硬过滤 1：封装 ---
  if (spec.footprint) {
    const want = norm(spec.footprint);
    if (!nfp.includes(want) && !nfp.startsWith(want)) continue;
  }

  // --- 硬过滤 2：值（电阻阻值/电容容值）---
  if (spec.value) {
    const want = norm(spec.value);
    const hit = nval.includes(want) || ndesc.includes(want) || nmfr.includes(want);
    if (!hit) continue;
  }

  // --- 硬过滤 3：描述关键词（类型确认）---
  if (spec.descHas) {
    if (!ndesc.includes(norm(spec.descHas))) continue;
  }
  if (spec.descNot) {
    const bad = Array.isArray(spec.descNot) ? spec.descNot : [spec.descNot];
    if (bad.some(b => ndesc.includes(norm(b)))) continue;
  }

  // --- 打分 ---
  let score = 0;
  if (klass === 'Basic Part') score += 100;
  if (nfp === norm(spec.footprint || '')) score += 30;
  if (spec.value && nval === norm(spec.value)) score += 20;
  if (/^\d/.test(name)) score += 5;
  if (desc.length > 20) score += 5;

  cands.push({
    lcsc, klass, name, value: p.Value, footprint: fp,
    desc: desc.slice(0, 60), mfrPart: mfr, score,
    symbolUuid: d.symbolUuid, footprintUuid: d.footprintUuid, libraryUuid: d.libraryUuid,
  });
}

cands.sort((a, b) => b.score - a.score);
return {
  spec,
  raw: (res || []).length,
  matched: cands.length,
  best: cands[0] || null,
  top: cands.slice(0, 5),
};
