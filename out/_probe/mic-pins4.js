const PINS = [
  ['USBC165948', 'C165948'],
  ['LDO6186',    'C6186'],
  ['SPK',        'C131337'],
];
const out = {};
for (const [tag, lcsc] of PINS) {
  try {
    const r = await eda.lib_Device.getByLcscIds([lcsc]);
    const dev = Array.isArray(r) ? r[0] : (r?.lists?.[0] || r?.value?.[0] || null);
    if (!dev) { out[tag] = { lcsc, err: 'NOT FOUND' }; continue; }
    const rec = { lcsc, name: dev.name, klass: (dev.otherProperty||{})['JLCPCB Part Class'] || '(空)',
                  fp: (dev.otherProperty||{})['Supplier Footprint'] || '' };
    try {
      const g = await eda.lib_Symbol.getGeometry(dev.symbolUuid, dev.libraryUuid);
      const gv = g?.value ?? g;
      const pl = gv?.pins || [];
      rec.pinCount = pl.length;
      rec.pins = pl.map(p => `${p.pinNumber}:${p.pinName}`);
    } catch (e) { rec.geoErr = String(e && e.message).slice(0, 110); }
    out[tag] = rec;
  } catch (e) { out[tag] = { lcsc, err: String(e && e.message).slice(0, 120) }; }
  await new Promise(r => setTimeout(r, 120));
}
return out;