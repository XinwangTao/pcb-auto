const out = { search: {}, pins: {} };
// ① 补搜：10k 电阻、Type-C 16P（要真实的）、IMU
const KW = [
  ['r10k', '10k 0603 resistor'],
  ['r10k_b', '0402WGF1002TCE'],
  ['typec', 'TYPE-C-31-M-12'],
  ['typec_b', 'USB Type-C 16P SMD connector'],
  ['imu_b', 'QMI8658'],
];
for (const [tag, kw] of KW) {
  out.search[tag] = [];
  try {
    const res = await eda.lib_Device.search(kw, undefined, undefined, undefined, 10, 1);
    for (const d of (res || [])) {
      const p = d.otherProperty || {};
      if (!p['Supplier Part']) continue;
      out.search[tag].push({
        lcsc: p['Supplier Part'], name: d.name,
        klass: p['JLCPCB Part Class'] || '(空)',
        fp: p['Supplier Footprint'] || '',
        ds: (p['Datasheet'] || '') ? 1 : 0,
      });
    }
  } catch (e) { out.search[tag] = [{ err: String(e && e.message).slice(0, 90) }]; }
  await new Promise(r => setTimeout(r, 150));
}
// ② 引脚：已确认料号 + 新候选
const PINS = [
  ['IMU2',   'C2912107'],   // MPU6050-YJLTY Extended
  ['TP4056', 'C16581'],
  ['BATT',   'C131337'],
  ['LED',    'C2297'],
  ['R1K',    'C11702'],
  ['R5K1',   'C25905'],
  ['R10K',   'C25804'],
  ['C100N',  'C14663'],
  ['C10U',   'C440198'],
];
for (const [tag, lcsc] of PINS) {
  try {
    const r = await eda.lib_Device.getByLcscIds([lcsc]);
    const dev = Array.isArray(r) ? r[0] : (r?.lists?.[0] || r?.value?.[0] || null);
    if (!dev) { out.pins[tag] = { lcsc, err: 'NOT FOUND' }; continue; }
    const rec = { lcsc, name: dev.name, klass: (dev.otherProperty || {})['JLCPCB Part Class'] || '(空)' };
    try {
      const g = await eda.lib_Symbol.getGeometry(dev.symbolUuid, dev.libraryUuid);
      const gv = g?.value ?? g;
      const pl = gv?.pins || [];
      rec.pinCount = pl.length;
      rec.pins = pl.map(p => `${p.pinNumber}:${p.pinName}`);
    } catch (e) { rec.geoErr = String(e && e.message).slice(0, 100); }
    out.pins[tag] = rec;
  } catch (e) { out.pins[tag] = { lcsc, err: String(e && e.message).slice(0, 120) }; }
  await new Promise(r => setTimeout(r, 120));
}
return out;