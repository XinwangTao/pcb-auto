// ============================================================
// pcb-auto 全流程单脚本（在 lceda-pro 编辑器内执行）
// 输入：__CLI__.args = { idea, design, outDir, friendly }
// 输出：完整 JSON 报告 + 磁盘产物
// ============================================================
const L = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const A = __CLI__.args;
const log = (s, v) => L.push(v === undefined ? { s } : { s, v });
const t0 = Date.now();
const phase = (name) => log('PHASE', { name, at: Date.now() - t0 });

const DESIGN = A.design;             // BOM + netlist 定义
const PARTS = A.parts;               // 已验证的选料库
const OUT = A.outDir;
const friendly = A.friendly || ('AI_AutoBoard_' + Date.now());

// ---------- helper ----------
function norm(s) {
  return String(s || '').toUpperCase().replace(/\s+/g, '').replace(/Ω|OHM/g, 'R').replace(/μ|µ/g, 'U');
}

async function waitDoc(uuid, ms = 120000) {
  await eda.dmt_EditorControl.openDocument(uuid);
  await eda.dmt_EditorControl.waitForDocumentReady(uuid, ms);
}

async function waitJob(jobId, maxMs = 600000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const st = await eda.pcb_Document.getAutoJobStatus(jobId);
    const state = String(st?.state ?? st?.status ?? '').toLowerCase();
    if (['completed', 'failed', 'cancelled', 'canceled'].includes(state)) {
      return { state, st, elapsed: Date.now() - start };
    }
    await sleep(1200);
  }
  return { state: 'TIMEOUT', elapsed: Date.now() - start };
}

const report = { ok: false, steps: [], artifacts: [], errors: [] };

// ============================================================
// 1. 建工程
// ============================================================
phase('createProject');
let projectUuid = null;
for (let i = 0; i < 3 && !projectUuid; i++) {
  try { projectUuid = await eda.dmt_Project.createProject(friendly, null, null, null, 'AI 全自动生成'); }
  catch (e) { log('createProjectRetry', { i, m: String(e && e.message) }); await sleep(1500); }
}
if (!projectUuid) throw new Error('createProject failed');
log('projectUuid', projectUuid);

await eda.dmt_Project.openProject(projectUuid);
await sleep(2000);
await eda.dmt_Project.waitForReady(projectUuid, 60000);

// ============================================================
// 2. 建 Board（自动带原理图+PCB）
// ============================================================
phase('createBoard');
let board = null;
for (let i = 0; i < 5; i++) {
  await eda.dmt_Board.createBoard();
  await sleep(2000);
  await eda.dmt_Project.waitForReady(projectUuid, 60000);
  const boards = await eda.dmt_Board.getAllBoardsInfo();
  if (boards && boards.length && boards[0].schematic && boards[0].pcb) { board = boards[0]; break; }
}
if (!board) throw new Error('no board with schematic+pcb');
const schName = board.schematic.name;
const pageName = board.schematic.page[0].name;
const pageUuid = board.schematic.page[0].uuid;
const schUuid = board.schematic.uuid;
const pcbUuid = board.pcb.uuid;
log('board', { name: board.name, schName, pageName, pageUuid, schUuid, pcbUuid });

// ============================================================
// 3. 选料 + 放器件
// ============================================================
phase('placeComponents');
const placed = [];      // { des, partKey, primitiveId, pins[] }
for (const item of DESIGN.components) {
  const part = PARTS[item.part];
  if (!part) { report.errors.push(`part missing: ${item.part}`); continue; }
  const r = await eda.sch_SourcePrimitiveComponent.add({
    projectId: projectUuid, schematicName: schName, pageName,
    libraryUuid: part.libraryUuid, name: part.name,
    x: 100 + placed.length * 80, y: 200,
    designator: item.des,
    properties: { Value: part.value || item.des },
  });
  if (!r?.ok) { report.errors.push(`add fail ${item.des}: ${JSON.stringify(r)}`); continue; }
  const g = await eda.sch_SourcePrimitiveComponent.get({
    projectId: projectUuid, schematicName: schName, pageName,
    primitiveId: r.value.primitiveId,
  });
  placed.push({
    des: r.value.designator, partKey: item.part, primitiveId: r.value.primitiveId,
    pins: g.value.pins, props: g.value.properties,
  });
}
log('placed', placed.map(p => ({ des: p.des, part: p.partKey, pins: p.pins.map(x => `${x.pinNumber}:${x.pinName}`) })));
if (!placed.length) throw new Error('no components placed');

// 等落盘
await eda.sch_SourceDocument.waitForPersistReady(projectUuid, 60000);
await sleep(1500);

// ============================================================
// 4. 连通：按 net 分组画导线 + 网络符号
// ============================================================
phase('wireNets');

// 建立 (des, pinKey) -> pin 对象 映射；pinKey 支持 pinNumber 或 pinName
function findPin(des, key) {
  const c = placed.find(p => p.des === des);
  if (!c) return null;
  const k = String(key);
  return c.pins.find(p => String(p.pinNumber) === k) || c.pins.find(p => String(p.pinName) === k) || null;
}

// net -> [{des, pinKey, pin}]
const netGroups = {};
for (const [des, pinKey, net] of (DESIGN.connections || [])) {
  const pin = findPin(des, pinKey);
  if (!pin) { report.errors.push(`pin not found: ${des}.${pinKey}`); continue; }
  (netGroups[net] = netGroups[net] || []).push({ des, pinKey, pin });
}
log('netGroups', Object.fromEntries(Object.entries(netGroups).map(([k, v]) => [k, v.map(x => `${x.des}.${x.pinKey}@(${x.pin.x},${x.pin.y})`)])));

// 布局导线：每个 net 用一条总线 y = baseY + idx*40，逐个引脚竖直引出再水平连到总线
let busY = 300;
const wireResults = [];
const netFlagResults = [];
for (const [net, pins] of Object.entries(netGroups)) {
  const isPower = ['GND', 'VCC', 'VBUS', 'V3V3', '3V3', '5V'].includes(net.toUpperCase());
  busY += 40;

  // 收集所有需要连的点
  const pts = pins.map(p => ({ x: p.pin.x, y: p.pin.y, des: p.des, key: p.pinKey }));

  // 单点网络（或电源网络）→ 用网络符号，不画长总线
  if (pts.length === 1 || (isPower && pts.length <= 12)) {
    for (const pt of pts) {
      const type = net.toUpperCase() === 'GND' ? 'Ground' : 'Power';
      // 符号锚点：电源朝上/地朝下；引脚在锚点反向
      const ny = type === 'Ground' ? pt.y - 20 : pt.y + 20;
      try {
        const r = await eda.sch_SourcePrimitiveComponent.addNetFlag({
          projectId: projectUuid, schematicName: schName, pageName,
          type, net, x: pt.x, y: ny,
        });
        netFlagResults.push({ net, at: [pt.x, ny], ok: !!r?.ok, id: r?.value?.primitiveId });
        // 从引脚到符号画一段竖线
        const w = await eda.sch_SourcePrimitiveWire.add({
          projectId: projectUuid, schematicName: schName, pageName,
          line: [pt.x, pt.y, pt.x, ny], net,
        });
        wireResults.push({ net, seg: [[pt.x, pt.y], [pt.x, ny]], ok: !!w?.ok });
      } catch (e) {
        report.errors.push(`netflag ${net}@${pt.x},${pt.y}: ${e && e.message}`);
      }
    }
    continue;
  }

  // 多点网络 → 画总线（阶梯式：竖到线槽，再水平）
  const sorted = [...pts].sort((a, b) => a.x - b.x);
  const minX = Math.min(...sorted.map(p => p.x));
  const maxX = Math.max(...sorted.map(p => p.x));
  for (const pt of sorted) {
    // 竖线：引脚 → 总线
    try {
      const w = await eda.sch_SourcePrimitiveWire.add({
        projectId: projectUuid, schematicName: schName, pageName,
        line: [pt.x, pt.y, pt.x, busY], net,
      });
      wireResults.push({ net, seg: [[pt.x, pt.y], [pt.x, busY]], ok: !!w?.ok });
    } catch (e) { report.errors.push(`wire-v ${net}: ${e && e.message}`); }
  }
  // 水平总线
  if (maxX > minX) {
    try {
      const w = await eda.sch_SourcePrimitiveWire.add({
        projectId: projectUuid, schematicName: schName, pageName,
        line: [minX, busY, maxX, busY], net,
      });
      wireResults.push({ net, seg: [[minX, busY], [maxX, busY]], ok: !!w?.ok });
    } catch (e) { report.errors.push(`wire-h ${net}: ${e && e.message}`); }
  }
}
log('wires', { count: wireResults.length, failed: wireResults.filter(w => !w.ok).length });
log('netFlags', { count: netFlagResults.length, failed: netFlagResults.filter(w => !w.ok).length });

// 未连接的引脚 → setNoConnect（@alpha，运行时探测）
const connectedPins = new Set();
for (const [net, pins] of Object.entries(netGroups)) {
  for (const p of pins) connectedPins.add(`${p.des}.${p.pinKey}`);
}
const ncCandidates = [];
for (const c of placed) {
  for (const pin of c.pins) {
    const byNum = `${c.des}.${pin.pinNumber}`;
    const byName = `${c.des}.${pin.pinName}`;
    if (!connectedPins.has(byNum) && !connectedPins.has(byName)) {
      ncCandidates.push({ des: c.des, pinId: pin.pinId, pinNumber: pin.pinNumber, pinName: pin.pinName });
    }
  }
}
log('unconnectedPins', ncCandidates.length);
// 尝试 setNoConnect（签名未知，多形态探测）
let ncOk = 0;
for (const nc of ncCandidates) {
  const attempts = [
    () => eda.sch_SourcePin.setNoConnect({ projectId: projectUuid, schematicName: schName, pageName, pinId: nc.pinId }),
    () => eda.sch_SourcePin.setNoConnect({ projectId: projectUuid, schematicName: schName, pageName, pinId: nc.pinId, noConnect: true }),
  ];
  for (const f of attempts) {
    try { const r = await f(); if (r) { ncOk++; break; } } catch (e) { }
  }
}
log('setNoConnect', { candidates: ncCandidates.length, ok: ncOk });

await eda.sch_SourceDocument.waitForPersistReady(projectUuid, 60000);
await sleep(1500);

// ============================================================
// 5. 网表验证
// ============================================================
phase('netlist');
let netlistStr = null;
try {
  await waitDoc(pageUuid);
  await sleep(1200);
  netlistStr = await eda.sch_Netlist.getNetlist();
  log('netlistLen', String(netlistStr).length);
} catch (e) { report.errors.push('netlist: ' + (e && e.message)); }

// 原理图 DRC
let schDrc = null;
try { schDrc = await eda.sch_Drc.check(); log('schDrc', schDrc); }
catch (e) { report.errors.push('schDrc: ' + (e && e.message)); }

// ============================================================
// 6. PCB：导入变更 + 板框
// ============================================================
phase('pcbImport');
await waitDoc(pcbUuid);
await sleep(1200);

let imported = false;
for (let i = 0; i < 4; i++) {
  try { imported = await eda.pcb_Document.importChanges(schUuid, true); } catch (e) { }
  if (imported) break;
  await sleep(2000);
}
log('importChanges', imported);
await sleep(1500);

// 板框（单位 mil；1mm = 39.37mil）
const bw = A.boardWidthMil || 1200;    // ≈30.5mm
const bh = A.boardHeightMil || 900;    // ≈22.9mm
let outlineOk = false;
try {
  const poly = eda.pcb_MathPolygon.createPolygon(['R', 0, 0, bw, bh, 0, 0]);
  const pl = await eda.pcb_PrimitivePolyline.create('', 11, poly, 10, false);
  outlineOk = !!pl;
  log('boardOutline', { ok: outlineOk, w: bw, h: bh });
} catch (e) { report.errors.push('outline: ' + (e && e.message)); }

// ============================================================
// 7. 自动布局
// ============================================================
phase('autoLayout');
let layoutState = null;
try {
  const job = await eda.pcb_Document.startAutoLayout();
  if (job?.jobId) { const r = await waitJob(job.jobId, 300000); layoutState = r.state; log('layout', r); }
} catch (e) { report.errors.push('autoLayout: ' + (e && e.message)); }
await sleep(800);

// ============================================================
// 8. 自动布线（ULTRA_FAST）
// ============================================================
phase('autoRouting');
let routeState = null, routeLog = '';
try {
  const job = await eda.pcb_Document.startAutoRouting({
    optimization: EPCB_AutoRoutingOptimization.ULTRA_FAST,
    existingPrimitiveMode: EPCB_AutoRoutingExistingPrimitiveMode.REMOVE,
    engineConfig: { layers: [{ id: 1, dir: 'V' }, { id: 2, dir: 'H' }] },
  });
  if (job?.jobId) {
    const r = await waitJob(job.jobId, 600000);
    routeState = r.state;
    log('route', r);
    try { routeLog = String(await eda.pcb_Document.getAutoJobLog(job.jobId) || '').slice(0, 2000); } catch (e) { }
  }
} catch (e) {
  report.errors.push('autoRouting: ' + (e && e.message));
  // 回退常规引擎
  try {
    const job2 = await eda.pcb_Document.startAutoRouting({});
    if (job2?.jobId) { const r2 = await waitJob(job2.jobId, 600000); routeState = r2.state; log('routeFallback', r2); }
  } catch (e2) { report.errors.push('autoRoutingFallback: ' + (e2 && e2.message)); }
}
await eda.pcb_Document.save();
await sleep(1000);

// ============================================================
// 9. DRC
// ============================================================
phase('drc');
let drcResult = null;
try { drcResult = await eda.pcb_Drc.getDrcResult(); log('drc', { state: drcResult?.state, total: drcResult?.totalCount }); }
catch (e) { report.errors.push('drc: ' + (e && e.message)); }

// ============================================================
// 10. 导出生产资料
// ============================================================
phase('export');
const fs = eda.sys_FileSystem;
function toBlob(data) {
  if (data instanceof Blob) return data;
  if (typeof data === 'string') return new Blob([data]);
  return new Blob([JSON.stringify(data)]);
}
async function exportOne(name, getter) {
  try {
    const data = await getter();
    if (!data) return { name, ok: false, why: 'null' };
    const blob = toBlob(data);
    const r = await fs.saveFileToFileSystem(OUT + '\\' + name, blob, name);
    const ok = !!r;
    if (ok) report.artifacts.push({ name, size: blob.size });
    return { name, ok, size: blob.size };
  } catch (e) { return { name, ok: false, err: String(e && e.message) }; }
}

const exports = [];
exports.push(await exportOne('Gerber.zip', () => eda.pcb_ManufactureData.getGerberFile('AI_Board')));
exports.push(await exportOne('BOM.xlsx', () => eda.pcb_ManufactureData.getBomFile()));
exports.push(await exportOne('PnP.csv', () => eda.pcb_ManufactureData.getPickAndPlaceFile('AI_Board', 'csv', 'mm')));
exports.push(await exportOne('Netlist.json', () => eda.pcb_Net.getNetlist()));
exports.push(await exportOne('TestPoints.csv', () => eda.pcb_ManufactureData.getTestPointFile('AI_Board')));
exports.push(await exportOne('IpcD356A.d356', () => eda.pcb_ManufactureData.getIpcD356AFile('AI_Board')));
exports.push(await exportOne('PCB.pdf', () => eda.pcb_ManufactureData.getPdfFile('AI_Board')));
log('exports', exports);

// ============================================================
// 汇总
// ============================================================
report.ok = !!projectUuid && !!pcbUuid && !!outlineOk && exportedCountOk();
function exportedCountOk() { return report.artifacts.length >= 4; }

return {
  ok: report.ok,
  idea: A.idea,
  projectUuid, boardName: board.name,
  schName, pageName, pageUuid, schUuid, pcbUuid,
  components: placed.map(p => ({ des: p.des, part: p.partKey, lcsc: p.props?.['Supplier Part'], value: p.props?.Value })),
  nets: Object.keys(netGroups),
  wires: wireResults.length,
  netFlags: netFlagResults.length,
  unconnectedPins: ncCandidates.length,
  schDrc, imported, outlineOk,
  layoutState, routeState,
  drc: drcResult ? { state: drcResult.state, totalCount: drcResult.totalCount } : null,
  exports,
  artifacts: report.artifacts,
  errors: report.errors,
  elapsedMs: Date.now() - t0,
  log: L,
};
