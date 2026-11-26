// 批量自动选料 v2：basic 前缀可选
const A = __CLI__.args;
const specs = A.specs;
const limit = A.limit || 40;

function norm(s) {
  return String(s || '').toUpperCase().replace(/\s+/g, '').replace(/Ω|OHM/g, 'R').replace(/μ|µ/g, 'U');
}

const out = {};
for (const spec of specs) {
  const kw = (spec.basic === false ? '' : 'basic ') + spec.kw;
  let res = [];
  let err = null;
  try { res = await eda.lib_Device.search(kw, undefined, undefined, undefined, limit, 1) || []; }
  catch (e) { err = String(e && e.message); }

  const cands = [];
  for (const d of res) {
    const p = d.otherProperty || {};
    const lcsc = p['Supplier Part'];
    const klass = p['JLCPCB Part Class'] || '';
    const fp = String(p['Supplier Footprint'] || '');
    const value = String(p.Value || '');
    const desc = String(d.description || '');
    const name = String(d.name || '');
    if (!/^C\d+$/.test(String(lcsc))) continue;
    if (/^C99\d{7}$/.test(String(lcsc))) continue;
    if (!klass) continue;
    if (spec.footprint && !norm(fp).includes(norm(spec.footprint))) continue;
    if (spec.value) {
      const want = norm(spec.value);
      if (!(norm(value).includes(want) || norm(desc).includes(want))) continue;
    }
    if (spec.descHas && !norm(desc).includes(norm(spec.descHas))) continue;
    if (spec.nameHas && !norm(name).includes(norm(spec.nameHas))) continue;
    if (spec.descNot) {
      const bad = Array.isArray(spec.descNot) ? spec.descNot : [spec.descNot];
      if (bad.some(b => norm(desc).includes(norm(b)))) continue;
    }
    let score = 0;
    if (klass === 'Basic Part') score += 100;
    if (spec.value && norm(value) === norm(spec.value)) score += 25;
    if (spec.footprint && norm(fp) === norm(spec.footprint)) score += 20;
    cands.push({ lcsc, klass, name: d.name, value, footprint: fp, desc: desc.slice(0, 80),
      mfr: p['Manufacturer Part'], score,
      symbolUuid: d.symbolUuid, footprintUuid: d.footprintUuid, libraryUuid: d.libraryUuid });
  }
  cands.sort((a, b) => b.score - a.score);
  out[spec.key] = { kw, err, raw: res.length, matched: cands.length, best: cands[0] || null, top3: cands.slice(0, 3) };
}
return out;
