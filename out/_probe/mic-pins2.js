const PARTS = [
  ['MCU',  'C2913199'], ['MIC',  'C2875567'], ['AMP',  'C910544'],
  ['IMU',  'C9900042518'], ['SW',   'C2832146'], ['USBC', 'C9900216560'],
];
const out = {};
for (const [tag, lcsc] of PARTS) {
  const rec = { tag, lcsc };
  try {
    const r = await eda.lib_Device.getByLcscIds([lcsc]);
    const dev = Array.isArray(r) ? r[0] : (r?.lists?.[0] || r?.value?.[0] || null);
    if (!dev) { rec.err = 'NOT FOUND'; out[tag] = rec; continue; }
    rec.name = dev.name;
    rec.symbolName = dev.symbolName;
    rec.libraryUuid = dev.libraryUuid;
    rec.footprintName = dev.footprintName;
    // dev.symbol 里有没有 pin 数据
    if (dev.symbol && typeof dev.symbol === 'object') {
      rec.symInlineKeys = Object.keys(dev.symbol);
      const pl = dev.symbol.pins || dev.symbol.pinList || null;
      if (pl) { rec.pinCount = pl.length; rec.pins = pl.map(p => ({ n: p.pinNumber ?? p.number ?? p.designator, nm: p.pinName ?? p.name })); }
    }
    if (!rec.pins) {
      try {
        const g = await eda.lib_Symbol.getGeometry(dev.symbolUuid, dev.libraryUuid);
        const gv = g?.value ?? g;
        rec.geoKeys = Object.keys(gv || {});
        const pl = gv?.pins || gv?.pinList || (Array.isArray(gv) ? gv : null);
        if (pl) { rec.pinCount = pl.length; rec.pins = pl.map(p => ({ n: p.pinNumber ?? p.number, nm: p.pinName ?? p.name })); }
        else rec.geoSample = JSON.stringify(gv).slice(0, 700);
      } catch (e) { rec.geoErr = String(e && e.message).slice(0, 140); }
    }
  } catch (e) { rec.err = String(e && e.message).slice(0, 160); }
  out[tag] = rec;
}
return out;