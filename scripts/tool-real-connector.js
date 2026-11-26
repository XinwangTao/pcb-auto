// 找真实 LCSC 编号的连接器：C99+7位 是社区伪编号，真实编号通常 ≤7 位数字
const A = __CLI__.args;
const kws = A.kws || [];
const pages = A.pages || 5;
const limit = 40;

const out = {};
for (const kw of kws) {
  const real = [], pseudo = [];
  const seen = new Set();
  for (let pg = 1; pg <= pages; pg++) {
    let res = [];
    try { res = await eda.lib_Device.search(kw, undefined, undefined, undefined, limit, pg) || []; }
    catch (e) { break; }
    if (!res.length) break;
    for (const d of res) {
      const p = d.otherProperty || {};
      const lcsc = String(p['Supplier Part'] || '');
      if (!/^C\d+$/.test(lcsc) || seen.has(lcsc)) continue;
      seen.add(lcsc);
      const fake = /^C99\d{7}$/.test(lcsc);
      const item = {
        lcsc, name: d.name, klass: p['JLCPCB Part Class'],
        footprint: p['Supplier Footprint'], desc: String(d.description || '').slice(0, 60),
        symbolUuid: d.symbolUuid, footprintUuid: d.footprintUuid, libraryUuid: d.libraryUuid,
      };
      if (fake) pseudo.push(item); else real.push(item);
    }
  }
  out[kw] = { scanned: seen.size, realCount: real.length, real: real.slice(0, 12), pseudoSample: pseudo.slice(0, 2).map(x => x.lcsc) };
}
return out;
