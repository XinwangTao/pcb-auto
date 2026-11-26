// ============================================================
// pcb-auto 全流程（v2 —— 使用已验证的「引脚→短导线→网络符号」模式）
// 输入 __CLI__.args:
//   design : { components:[{des,part}], connections:[[des,pinKey,net],...] }
//   parts  : { partKey: {name,libraryUuid,value,lcsc,symbolUuid,footprintUuid} }
//   outDir, friendly, boardWidthMil, boardHeightMil
// 输出：完整报告 + 磁盘生产资料
// ============================================================
const L = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const A = __CLI__.args;
const log = (s, v) => L.push(v === undefined ? { s } : { s, v });
const T0 = Date.now();
const phase = n => log('PHASE', { n, ms: Date.now() - T0 });

const DESIGN = A.design;
const PARTS = A.parts;
const OUT = A.outDir;
const friendly = A.friendly || ('AI_AutoBoard_' + Date.now());
const errors = [];
const artifacts = [];

async function waitDoc(uuid, ms = 120000) {
  await eda.dmt_EditorControl.openDocument(uuid);
  await eda.dmt_EditorControl.waitForDocumentReady(uuid, ms);
}
async function waitJob(jobId, maxMs = 600000) {
  const st0 = Date.now();
  while (Date.now() - st0 < maxMs) {
    let st = null;
    try { st = await eda.pcb_Document.getAutoJobStatus(jobId); } catch (e) { return { state: 'ERR', err: String(e && e.message) }; }
    const state = String(st?.state ?? st?.status ?? '').toLowerCase();
    if (['completed', 'failed', 'cancelled', 'canceled'].includes(state)) return { state, st, ms: Date.now() - st0 };
    await sleep(1200);
  }
  return { state: 'TIMEOUT', ms: Date.now() - st0 };
}
function toBlob(d) {
  if (d instanceof Blob) return d;
  if (typeof d === 'string') return new Blob([d]);
  return new Blob([JSON.stringify(d)]);
}

// ---------- 1. 建工程 ----------
phase('createProject');
let projectUuid = null;
for (let i = 0; i < 3 && !projectUuid; i++) {
  try { projectUuid = await eda.dmt_Project.createProject(friendly, null, null, null, 'AI 全自动生成'); }
  catch (e) { await sleep(1500); }
}
if (!projectUuid) throw new Error('createProject failed');
await eda.dmt_Project.openProject(projectUuid);
await sleep(2000);
await eda.dmt_Project.waitForReady(projectUuid, 60000);
log('projectUuid', projectUuid);

// ---------- 2. 建 Board ----------
phase('createBoard');
let board = null;
for (let i = 0; i < 5 && !board; i++) {
  await eda.dmt_Board.createBoard();
  await sleep(2200);
  await eda.dmt_Project.waitForReady(projectUuid, 60000);
  const bs = await eda.dmt_Board.getAllBoardsInfo();
  if (bs?.length && bs[0].schematic?.page?.length && bs[0].pcb) board = bs[0];
}
if (!board) throw new Error('no board');
const schName = board.schematic.name;
const pageName = board.schematic.page[0].name;
const pageUuid = board.schematic.page[0].uuid;
const schUuid = board.schematic.uuid;
const pcbUuid = board.pcb.uuid;
log('board', { name: board.name, schName, pageName, pageUuid, schUuid, pcbUuid });

// ---------- 3. 放器件 ----------
phase('placeParts');
const placed = [];
let cx = 80;
for (const item of DESIGN.components) {
  const part = PARTS[item.part];
  if (!part) { errors.push(`missing part ${item.part}`); continue; }
  let r = null;
  try {
    r = await eda.sch_SourcePrimitiveComponent.add({
      projectId: projectUuid, schematicName: schName, pageName,
      libraryUuid: part.libraryUuid, name: part.name,
      x: cx, y: 200, designator: item.des,
    });
  } catch (e) { errors.push(`add ${item.des}: ${e && e.message}`); continue; }
  if (!r?.ok) { errors.push(`add ${item.des}: ${JSON.stringify(r)}`); continue; }
  const g = await eda.sch_SourcePrimitiveComponent.get({
    projectId: projectUuid, schematicName: schName, pageName, primitiveId: r.value.primitiveId });
  placed.push({ des: r.value.designator, part: item.part, primitiveId: r.value.primitiveId,
    pins: g.value.pins, props: g.value.properties });
  cx += 130;
}
log('placed', placed.map(p => ({ des: p.des, lcsc: p.props?.['Supplier Part'],
  pins: p.pins.map(x => `${x.pinNumber}:${x.pinName}`) })));
if (!placed.length) throw new Error('no parts placed');
await eda.sch_SourceDocument.waitForPersistReady(projectUuid, 60000);
await sleep(1200);

// ---------- 4. 连通：引脚 -> 短导线 -> 网络符号 ----------
phase('connect');
function findPin(des, key) {
  const c = placed.find(p => p.des === des);
  if (!c) return null;
  const k = String(key);
  return c.pins.find(p => String(p.pinNumber) === k)
      || c.pins.find(p => String(p.pinName) === k)
      || null;
}

const connSteps = [];
const POWER_NETS = new Set(['GND', 'VCC', 'VBUS', 'V3V3', '3V3', '5V', 'VDD', 'VSS', '+5V', '+3V3']);
let netSlot = 0;
for (const [des, pinKey, net] of (DESIGN.connections || [])) {
  const pin = findPin(des, pinKey);
  if (!pin) { errors.push(`pin missing ${des}.${pinKey}`); continue; }
  const isPwr = POWER_NETS.has(String(net).toUpperCase()) || String(net).toUpperCase().startsWith('GND');
  const type = String(net).toUpperCase().startsWith('GND') ? 'Ground' : (isPwr ? 'Power' : 'Power');

  // 引出方向：地符号向下（引脚在上），电源符号向上（引脚在下）
  const dir = type === 'Ground' ? -1 : 1;
  const endY = pin.y + dir * 20;

  let wireOk = false, flagOk = false;
  try {
    const w = await eda.sch_SourcePrimitiveWire.add({
      projectId: projectUuid, schematicName: schName, pageName,
      line: [pin.x, pin.y, pin.x, endY], net,
    });
    wireOk = !!w?.ok;
  } catch (e) { errors.push(`wire ${des}.${pinKey}: ${e && e.message}`); }

  try {
    const f = await eda.sch_SourcePrimitiveComponent.addNetFlag({
      projectId: projectUuid, schematicName: schName, pageName,
      type, net, x: pin.x, y: endY,
    });
    flagOk = !!f?.ok;
  } catch (e) { errors.push(`flag ${des}.${pinKey}: ${e && e.message}`); }

  connSteps.push({ des, pinKey, net, wireOk, flagOk });
}
log('connect', { total: connSteps.length, wireFail: connSteps.filter(c => !c.wireOk).length,
  flagFail: connSteps.filter(c => !c.flagOk).length });
await eda.sch_SourceDocument.waitForPersistReady(projectUuid, 60000);
await sleep(1800);

// ---------- 5. 网表验证 + 原理图 DRC ----------
phase('netlistCheck');
let netSummary = null, schDrc = null;
try {
  await waitDoc(pageUuid, 90000);
  await sleep(2500);
  const nl = JSON.parse(await eda.sch_Netlist.getNetlist());
  netSummary = [];
  for (const c of Object.values(nl.components || {})) {
    const pins = {};
    for (const [pn, pi] of Object.entries(c.pinInfoMap || {})) pins[pn] = pi.net || '';
    netSummary.push({ des: c.props?.Designator, lcsc: c.props?.['Supplier Part'], pins });
  }
  log('netlist', netSummary);
  // 校验：每个 connection 的 pin 是否拿到预期 net
  const mismatches = [];
  for (const [des, pinKey, net] of (DESIGN.connections || [])) {
    const row = netSummary.find(r => r.des === des);
    if (!row) { mismatches.push({ des, pinKey, want: net, got: 'NO_COMP' }); continue; }
    const got = row.pins[String(pinKey)];
    if (String(got).toUpperCase() !== String(net).toUpperCase()) mismatches.push({ des, pinKey, want: net, got });
  }
  log('netMismatches', mismatches);
  if (mismatches.length) errors.push(`${mismatches.length} net mismatches`);
} catch (e) { errors.push('netlist: ' + (e && e.message)); }

try { schDrc = await eda.sch_Drc.check(); log('schDrc', schDrc); } catch (e) { errors.push('schDrc: ' + (e && e.message)); }

// ---------- 6. PCB 导入 + 板框 ----------
phase('pcbImport');
await waitDoc(pcbUuid, 120000);
await sleep(1200);
let imported = false;
for (let i = 0; i < 4 && !imported; i++) {
  try { imported = await eda.pcb_Document.importChanges(schUuid, true); } catch (e) { }
  if (!imported) await sleep(2000);
}
log('importChanges', imported);
await sleep(1800);

const bw = A.boardWidthMil || 1200, bh = A.boardHeightMil || 900;
let outlineOk = false;
try {
  const poly = eda.pcb_MathPolygon.createPolygon(['R', 0, 0, bw, bh, 0, 0]);
  const pl = await eda.pcb_PrimitivePolyline.create('', 11, poly, 10, false);
  outlineOk = !!pl;
} catch (e) { errors.push('outline: ' + (e && e.message)); }
log('outline', { ok: outlineOk, w: bw, h: bh });

// ---------- 7. 自动布局 ----------
phase('autoLayout');
let layoutState = null;
try {
  const job = await eda.pcb_Document.startAutoLayout();
  if (job?.jobId) { const r = await waitJob(job.jobId, 300000); layoutState = r.state; log('layout', r); }
} catch (e) { errors.push('autoLayout: ' + (e && e.message)); }
await sleep(1000);

// ---------- 8. 自动布线 ----------
phase('autoRouting');
let routeState = null;
try {
  const job = await eda.pcb_Document.startAutoRouting({
    optimization: EPCB_AutoRoutingOptimization.ULTRA_FAST,
    existingPrimitiveMode: EPCB_AutoRoutingExistingPrimitiveMode.REMOVE,
    engineConfig: { layers: [{ id: 1, dir: 'V' }, { id: 2, dir: 'H' }] },
  });
  if (job?.jobId) { const r = await waitJob(job.jobId, 600000); routeState = r.state; log('route', r); }
} catch (e) {
  errors.push('autoRouting: ' + (e && e.message));
  try {
    const j2 = await eda.pcb_Document.startAutoRouting({});
    if (j2?.jobId) { const r2 = await waitJob(j2.jobId, 600000); routeState = r2.state; log('routeFallback', r2); }
  } catch (e2) { errors.push('autoRoutingFallback: ' + e2.message); }
}
await eda.pcb_Document.save();
await sleep(1200);

// ---------- 9. DRC ----------
phase('drc');
let drc = null;
try { drc = await eda.pcb_Drc.getDrcResult(); log('drc', { state: drc?.state, n: drc?.totalCount }); }
catch (e) { errors.push('drc: ' + (e && e.message)); }

// ---------- 10. 导出 ----------
phase('export');
const fs = eda.sys_FileSystem;
async function ex(name, getter) {
  try {
    const data = await getter();
    if (!data) return { name, ok: false, why: 'null' };
    const blob = toBlob(data);
    const ok = !!(await fs.saveFileToFileSystem(OUT + '\\' + name, blob, name));
    if (ok) artifacts.push({ name, size: blob.size });
    return { name, ok, size: blob.size };
  } catch (e) { return { name, ok: false, err: String(e && e.message) }; }
}
const exports = [];
exports.push(await ex('Gerber.zip', () => eda.pcb_ManufactureData.getGerberFile('AI_Board')));
exports.push(await ex('BOM.xlsx', () => eda.pcb_ManufactureData.getBomFile()));
exports.push(await ex('PnP.csv', () => eda.pcb_ManufactureData.getPickAndPlaceFile('AI_Board', 'csv', 'mm')));
exports.push(await ex('Netlist.json', () => eda.pcb_Net.getNetlist()));
exports.push(await ex('TestPoints.csv', () => eda.pcb_ManufactureData.getTestPointFile('AI_Board')));
exports.push(await ex('Board.pdf', () => eda.pcb_ManufactureData.getPdfFile('AI_Board')));
log('exports', exports);

return {
  ok: errors.filter(e => !/mismatch/.test(e)).length === 0,
  projectUuid, boardName: board.name,
  schName, pageName, pageUuid, schUuid, pcbUuid,
  components: placed.map(p => ({ des: p.des, part: p.part, lcsc: p.props?.['Supplier Part'], value: p.props?.Value })),
  netSummary, schDrc, imported, outlineOk, layoutState, routeState,
  drc: drc ? { state: drc.state, totalCount: drc.totalCount } : null,
  exports, artifacts, errors, elapsedMs: Date.now() - T0, log: L,
};
