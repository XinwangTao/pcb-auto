// 引脚实测：对候选料号取 device -> symbol，把引脚名/序号全 dump 出来
const PARTS = [
  ['MCU',  'C2913199'],
  ['MIC',  'C2875567'],
  ['AMP',  'C910544'],
  ['IMU',  'C9900042518'],
  ['SW',   'C2832146'],
  ['USBC', 'C9900216560'],
];
const out = {};
for (const [tag, lcsc] of PARTS) {
  const rec = { tag, lcsc };
  try {
    const r = await eda.lib_Device.getByLcscIds([lcsc]);
    const dev = Array.isArray(r) ? r[0] : (r?.lists?.[0] || r?.value?.[0] || null);
    if (!dev) { out[tag] = { ...rec, err: 'device NOT FOUND' }; continue; }
    rec.name = dev.name;
    rec.symbolUuid = dev.symbolUuid;
    rec.footprintUuid = dev.footprintUuid;
    rec.devKeys = Object.keys(dev);
    // 试着直接从 symbol 拿几何（含引脚名）
    if (dev.symbolUuid) {
      try {
        const g = await eda.lib_Symbol.getGeometry(dev.symbolUuid);
        rec.geoKeys = g && g.ok !== undefined ? ['ok', 'value'] : Object.keys(g || {});
        const pins = (g?.value?.pins) || (g?.value?.pinList) || (Array.isArray(g?.value) ? g.value : null);
        if (pins) {
          rec.pinCount = pins.length;
          rec.pins = pins.map(p => ({
            n: p.pinNumber ?? p.number ?? p.n,
            nm: p.pinName ?? p.name ?? p.nm,
            et: p.electricalType ?? p.type,
          }));
        } else {
          rec.geoSample = JSON.stringify(g?.value ?? g).slice(0, 600);
        }
      } catch (e) { rec.geoErr = String(e && e.message).slice(0, 120); }
    }
    // 符号单元本身可能也带 pin 列表
    if (!rec.pins && dev.symbolUuid) {
      try {
        const s = await eda.lib_Symbol.get(dev.symbolUuid);
        const sv = s?.value ?? s;
        rec.symKeys = Object.keys(sv || {});
        const pl = sv?.pins || sv?.pinList || null;
        if (pl) { rec.pinCount = pl.length; rec.pins = pl.map(p => ({ n: p.pinNumber ?? p.number, nm: p.pinName ?? p.name })); }
      } catch (e) { rec.symErr = String(e && e.message).slice(0, 120); }
    }
  } catch (e) { rec.err = String(e && e.message).slice(0, 160); }
  out[tag] = rec;
  await new Promise(r => setTimeout(r, 150));
}
return out;