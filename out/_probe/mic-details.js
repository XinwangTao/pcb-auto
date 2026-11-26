const PARTS = [
  ['MCU','C2913199'],['MIC','C2875567'],['AMP','C910544'],
  ['IMU','C9900042518'],['SW','C2832146'],['USBC','C9900216560'],
];
const out = {};
for (const [tag, lcsc] of PARTS) {
  try {
    const r = await eda.lib_Device.getByLcscIds([lcsc]);
    const dev = Array.isArray(r) ? r[0] : (r?.lists?.[0] || r?.value?.[0] || null);
    if (!dev) { out[tag] = { err: 'NOT FOUND' }; continue; }
    out[tag] = {
      lcsc, name: dev.name,
      description: String(dev.description || '').slice(0, 300),
      otherProperty: dev.otherProperty || {},
      footprintName: dev.footprintName,
      classification: dev.classification,
    };
  } catch (e) { out[tag] = { err: String(e && e.message).slice(0, 120) }; }
}
return out;