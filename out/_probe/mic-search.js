// 需求→料号搜索：五类关键器件一次性搜出来，只留可下单的
const R = {};
const CATS = [
  ['mcu',      ['ESP32-S3-WROOM-1', 'ESP32-S3-WROOM'],        ['module']],
  ['mic',      ['I2S microphone', 'INMP441', 'ICS-43434', 'MSM261'], ['mic']],
  ['amp',      ['MAX98357', 'PAM8403', 'NS4168', 'I2S amplifier'],   ['amp']],
  ['imu',      ['MPU6050', 'QMI8658', 'LSM6DS3', 'LIS3DH'],          ['imu']],
  ['sw',       ['tactile switch 3x4', 'TS-1088', '轻触开关'],        ['sw']],
  ['usbc',     ['TYPE-C-16P', 'USB Type-C 16P'],                     ['usb']],
];
for (const [cat, kws, tags] of CATS) {
  R[cat] = [];
  for (const kw of kws) {
    try {
      const res = await eda.lib_Device.search(kw, undefined, undefined, undefined, 12, 1);
      for (const d of (res || [])) {
        const p = d.otherProperty || {};
        const lcsc = p['Supplier Part'] || '';
        if (!lcsc) continue;
        R[cat].push({
          kw, lcsc, name: d.name,
          klass: p['JLCPCB Part Class'] || '',
          fp: p['Supplier Footprint'] || '',
          stock: p['Stock'] ?? p['Library Stock'] ?? null,
          desc: String(d.description || '').slice(0, 60),
        });
      }
    } catch (e) { R[cat].push({ kw, err: String(e && e.message).slice(0, 80) }); }
    await new Promise(r => setTimeout(r, 120));
  }
}
return R;