// 最小闭环验证：2 个器件 + 1 根导线 + 网络符号
// 目的：确认导线 API 与连通性判定
const L = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const A = __CLI__.args;
const log = (s, v) => L.push(v === undefined ? { s } : { s, v });

const projUuid = A.projectUuid;
await eda.dmt_Project.openProject(projUuid);
await sleep(1500);
await eda.dmt_Project.waitForReady(projUuid, 60000);

const boards = await eda.dmt_Board.getAllBoardsInfo();
const b = boards[0];
const schematicName = b.schematic.name, pageName = b.schematic.page[0].name;
const pcbUuid = b.pcb.uuid;
log('board', { schematicName, pageName, pcbUuid });

// 取两个器件
const devs = await eda.lib_Device.getByLcscIds(['C14663', 'C1525']);
const comps = [];
for (let i = 0; i < devs.length; i++) {
  const d = devs[i];
  const r = await eda.sch_SourcePrimitiveComponent.add({
    projectId: projUuid, schematicName, pageName,
    libraryUuid: d.libraryUuid, name: d.name,
    x: 100 + i * 100, y: 200,
  });
  if (!r?.ok) { log('addFail', r); continue; }
  const g = await eda.sch_SourcePrimitiveComponent.get({
    projectId: projUuid, schematicName, pageName, primitiveId: r.value.primitiveId });
  comps.push({ des: r.value.designator, primitiveId: r.value.primitiveId, pins: g.value.pins });
}
log('comps', comps);

// 画一根导线连接 comps[0].pins[1] -> comps[1].pins[0]
// 必须先水平/垂直，所以用 L 形两段
if (comps.length === 2) {
  const p1 = comps[0].pins[1];   // 右引脚
  const p2 = comps[1].pins[0];   // 左引脚
  // 中间走 y=200 直线（如果 y 相同）
  const wire = await eda.sch_SourcePrimitiveWire.add({
    projectId: projUuid, schematicName, pageName,
    line: [p1.x, p1.y, p2.x, p2.y],
    net: 'TESTNET',
  });
  log('wire', wire);
}

// 网络符号：GND
const gnd = await eda.sch_SourcePrimitiveComponent.addNetFlag({
  projectId: projUuid, schematicName, pageName,
  type: 'Ground', net: 'GND',
  x: comps[0].pins[0].x - 20, y: comps[0].pins[0].y,
});
log('gndFlag', gnd);

await eda.sch_SourceDocument.waitForPersistReady(projUuid, 60000);
log('persisted');

return { projUuid, pcbUuid, schematicName, pageName, comps, L };
