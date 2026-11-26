// 回退方案：逐词 search + getByLcscIds
const out = {};

// A. 模糊搜索
try {
  const r = await eda.lib_Device.search('10k 0402', undefined, undefined, undefined, 5, 1);
  out.search = {
    ok: true,
    count: (r || []).length,
    items: (r || []).map(d => ({
      uuid: d.uuid, name: d.name, displayTitle: d.displayTitle,
      supplierId: d.supplierId, lcscId: d.lcscId,
    })),
  };
} catch (e) { out.search = { ok: false, error: String(e && e.message), code: e?.code }; }

// B. 按 LCSC C 编号精确取（最可靠）
const probeIds = ['C1523', 'C14663', 'C2286', 'C6186', 'C72043'];
try {
  const r2 = await eda.lib_Device.getByLcscIds(probeIds);
  out.byLcsc = {
    ok: true,
    isArray: Array.isArray(r2),
    count: Array.isArray(r2) ? r2.length : null,
    sample: Array.isArray(r2) ? r2.slice(0, 2) : r2,
  };
} catch (e) { out.byLcsc = { ok: false, error: String(e && e.message), code: e?.code }; }

// C. 按属性精确搜索
try {
  const r3 = await eda.lib_Device.searchByProperties({ supplierId: 'C1523' });
  out.byProps = { ok: true, isArray: Array.isArray(r3), count: Array.isArray(r3) ? r3.length : null, sample: Array.isArray(r3) ? r3.slice(0,1) : r3 };
} catch (e) { out.byProps = { ok: false, error: String(e && e.message), code: e?.code }; }

return out;
