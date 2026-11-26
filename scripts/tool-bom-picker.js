// 批量自动选料：一次跑完 BOM 所需全部器件，产出已验证的 BOM 库
const A = __CLI__.args;
const specs = A.specs;   // [{ key, kw, footprint, value, descHas, kind }]
const limit = 40;

function norm(s) {
  return String(s || '').toUpperCase().replace(/\s+/g, '').replace(/Ω|OHM/g, 'R').replace(/μ|µ/g, 'U');
}

const out = {};
for (const spec of specs) {
  const kw = 'basic ' + spec.kw;
  let res = [];
  try { res = await eda.lib_Device.search(kw, undefined, undefined, undefined, limit, 1) || []; }
  catch (e) { out[spec.key] = { error: String(e && e.message) }; continue; }

  const cands = [];
  for (const d of res) {
    const p = d.otherProperty || {};
    const lcsc = p['Supplier Part'];
    const klass = p['JLCPCB Part Class'] || '';
    const fp = String(p['Supplier Footprint'] || '');
    const value = String(p.Value || '');
    const desc = String(d.description || '');
    if (!/^C\d+$/.test(lcsc) || /^C99\d{7}$/.test(lcsc)) continue;
    if (!klass) continue;
    if (spec.footprint && !norm(fp).includes(norm(spec.footprint))) continue;
    if (spec.value) {
      const want = norm(spec.value);
      if (!(norm(value).includes(want) || norm(desc).includes(want))) continue;
    }
    if (spec.descHas && !norm(desc).includes(norm(spec.descHas))) continue;
    if (spec.descNot) {
      const bad = Array.isArray(spec.descNot) ? spec.descNot : [spec.descNot];
      if (bad.some(b => norm(desc).includes(norm(b)))) continue;
    }
    let score = 0;
    if (klass === 'Basic Part') score += 100;
    if (spec.value && norm(value) === norm(spec.value)) score += 25;
    if (spec.footprint && norm(fp) === norm(spec.footprint)) score += 20;
    // 电压/精度加分
    if (spec.minVoltage) {
      const m = desc.match(/额定电压:([\d.]+)V/);
      if (m && parseFloat(m[1]) >= spec.minVoltage) score += 30;
    }
    cands.push({ lcsc, klass, name: d.name, value, footprint: fp, desc: desc.slice(0, 70), mfr: p['Manufacturer Part'], score,
      symbolUuid: d.symbolUuid, footprintUuid: d.footprintUuid, libraryUuid: d.libraryUuid });
  }
  cands.sort((a, b) => b.score - a.score);
  out[spec.key] = { raw: res.length, matched: cands.length, best: cands[0] || null, top3: cands.slice(0, 3) };
}
return out;
