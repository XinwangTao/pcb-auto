// 干净起点：删测试工程 -> 建新工程 -> createBoard() -> 回读 -> 放一个器件并回读验证
const L = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const A = __CLI__.args;

// ---- 0. 清理旧测试工程 ----
for (const u of (A.deleteProjects || [])) {
  try { L.push({ step: 'deleteProject', u, r: await eda.dmt_Project.deleteProject(u) }); }
  catch (e) { L.push({ step: 'deleteProject', u, error: String(e && e.message) }); }
}

// ---- 1. 建工程 ----
const friendly = A.friendly;
const projectUuid = await eda.dmt_Project.createProject(friendly, undefined, undefined, undefined, 'AI auto generated');
if (!projectUuid) throw new Error('createProject failed');
L.push({ step: 'createProject', projectUuid });

// ---- 2. 打开工程 ----
const opened = await eda.dmt_Project.openProject(projectUuid);
L.push({ step: 'openProject', opened });
await sleep(2000);
await eda.dmt_Project.waitForReady(projectUuid, 60000);

// ---- 3. createBoard() 自动建 原理图+PCB 对 ----
const boardName = await eda.dmt_Board.createBoard();
L.push({ step: 'createBoard', boardName });
await sleep(2500);
await eda.dmt_Project.waitForReady(projectUuid, 60000);

// ---- 4. 回读工程树 ----
const boards = await eda.dmt_Board.getAllBoardsInfo();
const board = (boards || [])[0];
L.push({ step: 'board', v: board });
if (!board) throw new Error('no board created');

const schematicName = board.schematic?.name;
const pageName = board.schematic?.page?.[0]?.name;
const pcbUuid = board.pcb?.uuid;
const schematicUuid = board.schematic?.uuid;
L.push({ step: 'ids', schematicName, pageName, pcbUuid, schematicUuid });
if (!schematicName || !pageName) throw new Error('schematic/page name missing');

// ---- 5. 选料 + 取几何 ----
const dev = (await eda.lib_Device.getByLcscIds([A.lcsc]))[0];
L.push({
  step: 'device',
  name: dev?.name, libraryUuid: dev?.libraryUuid,
  symbolUuid: dev?.symbolUuid, footprintUuid: dev?.footprintUuid,
  value: dev?.otherProperty?.Value, supplierPart: dev?.otherProperty?.['Supplier Part'],
});
const geo = await eda.lib_Symbol.getGeometry(dev.symbolUuid, dev.libraryUuid);
L.push({ step: 'geo', v: geo });

// ---- 6. 放置器件 ----
const addRes = await eda.sch_SourcePrimitiveComponent.add({
  projectId: projectUuid,
  schematicName,
  pageName,
  libraryUuid: dev.libraryUuid,
  name: dev.name,
  x: 100, y: 100,
  designator: 'C1',
});
L.push({ step: 'add', v: addRes });

await eda.sch_SourceDocument.waitForPersistReady(projectUuid, 60000);

// ---- 7. 回读验证 ----
try {
  const all = await eda.sch_SourcePrimitiveComponent.getAll
    ? null : null;
} catch (e) { }
try {
  const ids = await eda.sch_PrimitiveComponent.getAllPrimitiveId?.() ?? null;
  L.push({ step: 'primitiveIds', v: ids });
} catch (e) { L.push({ step: 'primitiveIds', error: String(e && e.message) }); }

return { projectUuid, boardName, schematicName, pageName, pcbUuid, schematicUuid, L };
