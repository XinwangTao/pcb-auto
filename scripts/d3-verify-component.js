// 验证已放置器件 + 找导线/网络符号 API 的真实签名
const L = [];
const A = __CLI__.args;

// ---- 回读原理图器件（Source API get）----
try {
  const g = await eda.sch_SourcePrimitiveComponent.get({
    projectId: A.projectUuid,
    schematicName: A.schematicName,
    pageName: A.pageName,
    primitiveId: A.primitiveId,
  });
  L.push({ step: 'getComponent', v: g });
} catch (e) {
  L.push({ step: 'getComponent', error: String(e && e.message), code: e?.code });
}

// ---- 试各种可能的"列器件"接口 ----
const tries = [
  ['sch_SourcePrimitiveComponent.getAll', async () => eda.sch_SourcePrimitiveComponent.getAll],
  ['sch_SourceDocument.getFunctionGroups', async () => eda.sch_SourceDocument.getFunctionGroups],
  ['sch_PrimitiveComponent.getAllPrimitiveId', async () => eda.sch_PrimitiveComponent.getAllPrimitiveId],
  ['sch_SourcePin.getGeometry', async () => eda.sch_SourcePin.getGeometry],
];
for (const [label, fn] of tries) {
  try { const f = await fn(); L.push({ step: label, hasFn: typeof f === 'function' }); }
  catch (e) { L.push({ step: label, error: String(e && e.message) }); }
}

// ---- 取引脚几何（验证器件引脚绝对坐标）----
try {
  const pinGeo = await eda.sch_SourcePin.getGeometry({
    projectId: A.projectUuid,
    schematicName: A.schematicName,
    pageName: A.pageName,
    primitiveId: A.primitiveId,
  });
  L.push({ step: 'pinGeometry', v: pinGeo });
} catch (e) {
  L.push({ step: 'pinGeometry', error: String(e && e.message) });
}

return L;
