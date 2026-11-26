// PCB 阶段：导入变更 + 画板框
const L = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const A = __CLI__.args;
const log = (s, v) => L.push(v === undefined ? { s } : { s, v });

const projUuid = A.projectUuid, pcbUuid = A.pcbUuid, schUuid = A.schematicUuid;

// 1. 激活 PCB 文档
await eda.dmt_EditorControl.openDocument(pcbUuid);
await eda.dmt_EditorControl.waitForDocumentReady(pcbUuid, 120000);
log('pcbDocReady');
await sleep(1000);

// 2. 从原理图导入变更（force=true 跳过弹窗）
for (let i = 0; i < 3; i++) {
  try {
    const r = await eda.pcb_Document.importChanges(schUuid, true);
    log('importChanges', { try: i + 1, r });
    if (r) break;
  } catch (e) { log('importErr', { try: i + 1, m: String(e && e.message) }); }
  await sleep(2000);
}

// 3. 读元件是否上板
await sleep(1500);
try {
  const comps = await eda.pcb_PrimitiveComponent.getAll();
  log('pcbComponents', Array.isArray(comps) ? comps.length : comps);
  if (Array.isArray(comps) && comps[0]) {
    log('comp0State', {
      des: comps[0].getState_Designator?.(),
      x: comps[0].getState_X?.(),
      y: comps[0].getState_Y?.(),
      layer: comps[0].getState_Layer?.(),
    });
  }
} catch (e) { log('compsErr', String(e && e.message)); }

// 4. 画板框：20mm x 15mm 矩形，层 11 (BOARD_OUTLINE)
// 进度单位需确认：先用 mil 试（1mm = 39.37mil）
try {
  const poly = eda.pcb_MathPolygon.createPolygon(['R', 0, 0, 800, 600, 0, 0]);
  const pl = await eda.pcb_PrimitivePolyline.create('', 11, poly, 10, false);
  log('boardOutline', { id: pl?.getState_PrimitiveId?.(), type: pl?.getState_PrimitiveType?.() });
} catch (e) { log('outlineErr', String(e && e.message)); }

// 5. 叠层信息
try { const st = await eda.pcb_Layer.getStackup(); log('stackup', st); }
catch (e) { log('stackupErr', String(e && e.message)); }

// 6. 全部层（只取启用信号层）
try {
  const layers = await eda.pcb_Layer.getAllLayers();
  if (Array.isArray(layers)) {
    log('signalLayers', layers.filter(l => l.type === 'SIGNAL' && l.layerStatus === 1)
      .map(l => ({ id: l.id, name: l.name, type: l.type })));
  }
} catch (e) { log('layersErr', String(e && e.message)); }

await eda.pcb_Document.save();
return L;
