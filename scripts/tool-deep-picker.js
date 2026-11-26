// 深度选料：跳过 C99 伪编号，直接从真实 LCSC 库里找
const A = __CLI__.args;
const specs = A.specs;
const pages = A.pages || 3;
const limit = A.limit || 40;

function norm(s) {
  return String(s || '').toUpperCase().replace(/\s+/g, '').replace(/Ω|OHM/g, 'R').replace(/μ|µ/g, 'U');
}

const out = {};
for (const spec of specs) {
  const all = [];
  let seen = new Set();
  for (let pg = 1; pg <= pages; pg++) {
    let res = [];
    try { res = await eda.lib_Device.search(spec.kw, undefined, undefined, undefined, limit, pg) || []; }
    catch (e) { break; }
    if (!res.length) break;
    for (const d of res) {
      const p = d.otherProperty || {};
      const lcsc = String(p['Supplier Part'] || '');
      if (!/^C\d+$/.test(lcsc)) continue;
      if (/^C99\d{7}$/.test(lcsc)) continue;      // 伪编号剔除
      if (seen.has(lcsc)) continue;
      seen.add(lcsc);
      const klass = p['JLCPCB Part Class'] || '';
      const fp = String(p['Supplier Footprint'] || '');
      const desc = String(d.description || '');
      const name = String(d.name || '');
      if (!klass) continue;
      if (spec.footprint && !norm(fp).includes(norm(spec.footprint))) continue;
      if (spec.descHas && !norm(desc).includes(norm(spec.descHas))) continue;
      if (spec.nameHas && !norm(name).includes(norm(spec.nameHas))) continue;
      if (spec.value) {
        const want = norm(spec.value);
        if (!(norm(p.Value).includes(want) || norm(desc).includes(want) || norm(name).includes(want))) continue;
      }
      let score = 0;
      if (klass === 'Basic Part') score += 100;
      if (spec.value && norm(p.Value) === norm(spec.value)) score += 25;
      if (spec.footprint && norm(fp) === norm(spec.footprint)) score += 20;
      all.push({ lcsc, klass, name: d.name, value: p.Value, footprint: fp,
        desc: desc.slice(0, 80), mfr: p['Manufacturer Part'], score,
        symbolUuid: d.symbolUuid, footprintUuid: d.footprintUuid, libraryUuid: d.libraryUuid });
    }
  }
  all.sort((a, b) => b.score - a.score);
  out[spec.key] = { kw: spec.kw, scanned: seen.size, matched: all.length, best: all[0] || null, top5: all.slice(0, 5) };
}
return out;
