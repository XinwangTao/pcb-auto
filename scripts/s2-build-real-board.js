// ============================================================
// pcb-auto: 从零建一块真实的板（原理图完整连通）
// 电路：USB-C 5V → 100nF → LDO(AMS1117-3.3) → 10uF → LED + 1k
// ============================================================
const L = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const A = __CLI__.args;
const log = (step, v) => L.push(v === undefined ? { step } : { step, v });

// ---------- 1. 建工程 ----------
const projectUuid = await eda.dmt_Project.createProject(A.friendly, undefined, undefined, undefined, 'AI 全自动生成');
if (!projectUuid) throw new Error('createProject failed');
log('createProject', projectUuid);

await eda.dmt_Project.openProject(projectUuid);
await sleep(2000);
await eda.dmt_Project.waitForReady(projectUuid, 60000);

// ---------- 2. createBoard 自动建 原理图+PCB ----------
await eda.dmt_Board.createBoard();
await sleep(2500);
await eda.dmt_Project.waitForReady(projectUuid, 60000);

const boards = await eda.dmt_Board.getAllBoardsInfo();
const board = boards[0];
const schematicName = board.schematic.name;       // Schematic1
const pageName = board.schematic.page[0].name;    // P1
const pcbUuid = board.pcb.uuid;
const schematicPageUuid = board.schematic.page[0].uuid;
log('board', { boardName: board.name, schematicName, pageName, pcbUuid, schematicPageUuid });

// ---------- 3. 选料（全部 Basic Part，真实可采购）----------
const wanted = [
  { lcsc: 'C14663',  des: 'C1', note: '100nF 0603 去耦' },
  { lcsc: 'C15850',  des: 'C2', note: '10uF 0805' },
  { lcsc: 'C6186',   des: 'U1', note: 'AMS1117-3.3 SOT-223' },
  { lcsc: 'C2286',   des: 'R1', note: '1k 0402' },
  { lcsc: 'C2296',   des: 'D1', note: 'LED 0805' },
  { lcsc: 'C72043',  des: 'J1', note: 'USB-C 16P' },
];
const ids = wanted.map(w => w.lcsc);
const devs = await eda.lib_Device.getByLcscIds(ids);
log('devices', devs.map((d, i) => ({
  want: wanted[i].lcsc, des: wanted[i].des,
  name: d?.name,
  class: d?.otherProperty?.['JLCPCB Part Class'],
  footprint: d?.otherProperty?.['Supplier Footprint'],
  value: d?.otherProperty?.Value,
})));

// ---------- 4. 取几何 + 放置 ----------
const placed = [];
let x = 60;
for (let i = 0; i < devs.length; i++) {
  const d = devs[i];
  if (!d) { log('miss', wanted[i].lcsc); continue; }
  const geo = await eda.lib_Symbol.getGeometry(d.symbolUuid, d.libraryUuid);
  const res = await eda.sch_SourcePrimitiveComponent.add({
    projectId: projectUuid,
    schematicName, pageName,
    libraryUuid: d.libraryUuid,
    name: d.name,
    x, y: 120,
    designator: wanted[i].des,
  });
  if (!res?.ok) { log('addFail', { des: wanted[i].des, res }); continue; }
  const comp = await eda.sch_SourcePrimitiveComponent.get({
    projectId: projectUuid, schematicName, pageName,
    primitiveId: res.value.primitiveId,
  });
  placed.push({
    des: res.value.designator,
    primitiveId: res.value.primitiveId,
    name: d.name,
    value: d.otherProperty?.Value,
    lcsc: d.otherProperty?.['Supplier Part'],
    pins: comp.value.pins,
    fullBBox: geo?.fullBBox,
  });
  x += 70;
}
log('placed', placed);

await eda.sch_SourceDocument.waitForPersistReady(projectUuid, 60000);

return { projectUuid, boardName: board.name, schematicName, pageName, pcbUuid, schematicPageUuid, placed, L };
