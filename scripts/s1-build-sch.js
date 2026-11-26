// ============================================================
// pcb-auto pipeline step 1: 建工程 + 原理图 + 放器件
// 零人工干预：全部通过 eda Source API
// ============================================================
const log = [];
const L = (m, v) => { log.push(v === undefined ? m : { msg: m, ...v }); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const projectFriendly = __CLI__.args.projectName || ('AI_AutoBoard_' + Date.now());

// ---------- 1. 创建工程 ----------
const projectUuid = await eda.dmt_Project.createProject(
  projectFriendly,
  undefined, undefined, undefined,
  'AI 全自动生成的 PCB 工程（零人工干预）'
);
if (!projectUuid) throw new Error('createProject returned undefined');
L('createProject', { projectUuid, projectFriendly });

const ready1 = await eda.dmt_Project.waitForReady(projectUuid, 60000);
L('waitForReady', { ready: ready1 });

// ---------- 2. 建板子（显式，避免游离原理图） ----------
const boardOk = await eda.dmt_Board.createBoard(projectUuid, 'Board1');
L('createBoard', { result: boardOk });
await eda.dmt_Project.waitForReady(projectUuid, 60000);

const boards = await eda.dmt_Board.getAllBoardsInfo();
L('boards', { names: boards.map(b => b.name) });

// ---------- 3. 建原理图 ----------
const schUuid = await eda.dmt_Schematic.createSchematic('Board1');
L('createSchematic', { schUuid });
if (!schUuid) throw new Error('createSchematic returned undefined');
await sleep(1500);
await eda.dmt_Project.waitForReady(projectUuid, 60000);

const schInfo = await eda.dmt_Schematic.getSchematicInfo(schUuid);
L('schematicInfo', {
  name: schInfo?.name,
  parentBoardName: schInfo?.parentBoardName,
  pages: (schInfo?.page || []).map(p => p.name),
});

const schName = schInfo?.name;
const pageName = (schInfo?.page || [])[0]?.name;
if (!schName || !pageName) throw new Error('schematic name/page missing');

// ---------- 4. 选料：真实 LCSC 器件 ----------
const lcsc = ['C14663', 'C1523'];   // 100nF 0603, 1nF 0402（先练通流程）
const devices = await eda.lib_Device.getByLcscIds(lcsc);
L('devices', {
  count: devices.length,
  names: devices.map(d => d.name),
  classes: devices.map(d => d.otherProperty?.['JLCPCB Part Class']),
});

// ---------- 5. 取符号几何 ----------
const parts = [];
for (const d of devices) {
  const geo = await eda.lib_Symbol.getGeometry(d.symbolUuid, d.libraryUuid);
  parts.push({
    name: d.name,
    symbolUuid: d.symbolUuid,
    libraryUuid: d.libraryUuid,
    footprintUuid: d.footprintUuid,
    value: d.otherProperty?.Value ?? d.name,
    supplierPart: d.otherProperty?.['Supplier Part'],
    geo: geo ? {
      bbox: geo.bbox ?? geo.boundingBox ?? null,
      pins: (geo.pins || []).map(p => ({
        name: p.name, number: p.number ?? p.pinNumber,
        x: p.x ?? p.connX ?? p.point?.x, y: p.y ?? p.connY ?? p.point?.y,
        side: p.side ?? p.edge,
      })),
      keys: Object.keys(geo),
    } : null,
  });
}
L('geometry', { parts: parts.map(p => ({ name: p.name, geo: p.geo })) });

// ---------- 6. 放置器件（按几何排布，避免压线） ----------
const placed = [];
let cursorX = 100;
for (let i = 0; i < parts.length; i++) {
  const p = parts[i];
  const res = await eda.sch_SourcePrimitiveComponent.add({
    projectId: projectUuid,
    schematicName: schName,
    pageName: pageName,
    libraryUuid: p.libraryUuid,
    name: p.name,
    x: cursorX,
    y: 100,
    designator: (i === 0 ? 'C1' : 'C2'),
  });
  L('add component', { name: p.name, res });
  placed.push({ name: p.name, res, x: cursorX, y: 100 });
  cursorX += 60;
}

await eda.sch_SourceDocument.waitForPersistReady(projectUuid, 60000);
L('persistReady', { ok: true });

return {
  projectUuid,
  projectFriendly,
  schName,
  pageName,
  parts: parts.map(p => ({ name: p.name, value: p.value, supplierPart: p.supplierPart, footprintUuid: p.footprintUuid })),
  placed,
  log,
};
