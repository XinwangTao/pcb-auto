const out = {};
for (const [tag, lcsc] of [['HDR2','C49023793']]) {
  try {
    const r = await eda.lib_Device.getByLcscIds([lcsc]);
    const dev = Array.isArray(r) ? r[0] : (r?.lists?.[0] || r?.value?.[0] || null);
    if (!dev) { out[tag] = { lcsc, err: 'NOT FOUND' }; continue; }
    const g = await eda.lib_Symbol.getGeometry(dev.symbolUuid, dev.libraryUuid);
    const gv = g?.value ?? g;
    out[tag] = { lcsc, name: dev.name,
      klass: (dev.otherProperty||{})['JLCPCB Part Class'] || '(空)',
      fp: (dev.otherProperty||{})['Supplier Footprint'] || '',
      pins: (gv?.pins || []).map(p => `${p.pinNumber}:${p.pinName}`) };
  } catch (e) { out[tag] = { lcsc, err: String(e && e.message).slice(0, 120) }; }
}
return out;