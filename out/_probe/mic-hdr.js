const out = { search: [], pins: {} };
for (const kw of ['2.54mm 1x2 pin header', 'PH2.0 2P connector', 'XH 2P 2.54']) {
  try {
    const res = await eda.lib_Device.search(kw, undefined, undefined, undefined, 8, 1);
    for (const d of (res || [])) {
      const p = d.otherProperty || {};
      if (!p['Supplier Part']) continue;
      out.search.push({ kw, lcsc: p['Supplier Part'], name: d.name,
        klass: p['JLCPCB Part Class'] || '(空)', fp: p['Supplier Footprint'] || '',
        des: p['Designator'] || '' });
    }
  } catch (e) { out.search.push({ kw, err: String(e && e.message).slice(0, 80) }); }
  await new Promise(r => setTimeout(r, 150));
}
return out;