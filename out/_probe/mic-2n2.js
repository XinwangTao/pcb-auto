const out = { search: {} };
for (const [tag, kw] of [['c2n2','2.2nF 0603 capacitor'],['c2n2b','0603CG2R2C500NT']]) {
  out.search[tag] = [];
  try {
    const res = await eda.lib_Device.search(kw, undefined, undefined, undefined, 8, 1);
    for (const d of (res || [])) {
      const p = d.otherProperty || {};
      if (!p['Supplier Part']) continue;
      out.search[tag].push({ lcsc: p['Supplier Part'], name: d.name,
        klass: p['JLCPCB Part Class'] || '(空)', fp: p['Supplier Footprint'] || '',
        val: d.Value || '' });
    }
  } catch (e) { out.search[tag] = [{ err: String(e && e.message).slice(0,90) }]; }
  await new Promise(r => setTimeout(r, 150));
}
return out;