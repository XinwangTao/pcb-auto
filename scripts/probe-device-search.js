// 验证自动选料接口：batchSearchDevices
const groups = await eda.lib_Device.batchSearchDevices({
  queries: [
    { wd: '10k 0402', limit: 3 },
    { wd: '100nF 0402', limit: 3 },
    { wd: 'LED 0805', limit: 3 },
    { wd: 'AMS1117-3.3', limit: 3 },
    { wd: 'USB-C 16P', limit: 3 },
    { wd: 'SHT30', limit: 3 },
  ],
});

const out = [];
for (const g of groups || []) {
  const items = (g.devices || []).map(d => ({
    uuid: d.uuid,
    title: d.displayTitle ?? d.name,
    supplierId: d.supplierId ?? d.lcscId ?? null,
    symbol: d.symbol ? (d.symbol.displayTitle ?? d.symbol.name) : null,
    symbolUuid: d.symbol ? d.symbol.uuid : null,
    footprint: d.footprint ? (d.footprint.displayTitle ?? d.footprint.name) : null,
    footprintUuid: d.footprint ? d.footprint.uuid : null,
  }));
  out.push({ wd: g.wd, total: g.total, count: items.length, items });
}
return out;
