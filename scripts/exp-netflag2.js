// 实验2：引脚 -> 短导线 -> 网络符号（符号必须在导线端点上）
const L = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const A = __CLI__.args;
const log = (s, v) => L.push(v === undefined ? { s } : { s, v });

const projUuid = A.projectUuid;
await eda.dmt_Project.openProject(projUuid);
await sleep(1800);
await eda.dmt_Project.waitForReady(projUuid, 60000);
const b = (await eda.dmt_Board.getAllBoardsInfo())[0];
const schematicName = b.schematic.name, pageName = b.schematic.page[0].name;
const pageUuid = b.schematic.page[0].uuid;

const dev = (await eda.lib_Device.getByLcscIds(['C1525']))[0];
const comps = [];
for (let i = 0; i < 3; i++) {
  const r = await eda.sch_SourcePrimitiveComponent.add({
    projectId: projUuid, schematicName, pageName,
    libraryUuid: dev.libraryUuid, name: dev.name,
    x: 100 + i * 120, y: 200,
  });
  const g = await eda.sch_SourcePrimitiveComponent.get({
    projectId: projUuid, schematicName, pageName, primitiveId: r.value.primitiveId });
  comps.push({ des: r.value.designator, primitiveId: r.value.primitiveId, pins: g.value.pins });
}
log('comps', comps.map(c => ({ des: c.des, pins: c.pins.map(p => `${p.pinNumber}@(${p.x},${p.y})`) })));

// 每个引脚：先画竖导线引出 20，再把 net flag 放在导线端点
const steps = [];
for (const c of comps) {
  for (const pin of c.pins) {
    const isPin1 = String(pin.pinNumber) === '1';
    const net = isPin1 ? 'VTEST' : 'GND';
    const type = isPin1 ? 'Power' : 'Ground';
    const dir = isPin1 ? 1 : -1;              // 电源向上引出，地向下载引出
    const endY = pin.y + dir * 20;

    // 1. 导线：引脚 -> 端点
    let wireOk = false;
    try {
      const w = await eda.sch_SourcePrimitiveWire.add({
        projectId: projUuid, schematicName, pageName,
        line: [pin.x, pin.y, pin.x, endY], net,
      });
      wireOk = !!w?.ok;
    } catch (e) { steps.push({ step: 'wire', err: String(e && e.message) }); }

    // 2. net flag 放在导线端点（符号引脚正好落在 endY）
    let flagOk = false;
    try {
      const r = await eda.sch_SourcePrimitiveComponent.addNetFlag({
        projectId: projUuid, schematicName, pageName,
        type, net, x: pin.x, y: endY,
      });
      flagOk = !!r?.ok;
    } catch (e) { steps.push({ step: 'flag', err: String(e && e.message) }); }

    steps.push({ des: c.des, pin: pin.pinNumber, net, wireOk, flagOk, seg: [pin.x, pin.y, pin.x, endY] });
  }
}
log('steps', steps);

await eda.sch_SourceDocument.waitForPersistReady(projUuid, 60000);
await sleep(2500);
await eda.dmt_EditorControl.openDocument(pageUuid);
await eda.dmt_EditorControl.waitForDocumentReady(pageUuid, 90000);
await sleep(2500);

let summary = [];
try {
  const nl = JSON.parse(await eda.sch_Netlist.getNetlist());
  for (const [uid, c] of Object.entries(nl.components || {})) {
    const pins = {};
    for (const [pn, pi] of Object.entries(c.pinInfoMap || {})) pins[pn] = pi.net || '(none)';
    summary.push({ des: c.props?.Designator, pins });
  }
} catch (e) { log('nlErr', String(e && e.message)); }
log('netlistSummary', summary);
try { log('schDrc', await eda.sch_Drc.check()); } catch (e) { }

return { L, summary };
