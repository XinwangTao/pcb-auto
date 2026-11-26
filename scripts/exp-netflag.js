// 关键实验：网络符号（net flag）按名称是否能建立真实电气连通
// 若可行，全自动原理图将无需几何计算，鲁棒性大幅提升
const L = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const A = __CLI__.args;
const log = (s, v) => L.push(v === undefined ? { s } : { s, v });

const projUuid = A.projectUuid;
await eda.dmt_Project.openProject(projUuid);
await sleep(1800);
await eda.dmt_Project.waitForReady(projUuid, 60000);

const boards = await eda.dmt_Board.getAllBoardsInfo();
const b = boards[0];
const schematicName = b.schematic.name, pageName = b.schematic.page[0].name;
const pageUuid = b.schematic.page[0].uuid;
log('board', { schematicName, pageName });

// 放 3 个电容
const dev = (await eda.lib_Device.getByLcscIds(['C1525']))[0];
const comps = [];
for (let i = 0; i < 3; i++) {
  const r = await eda.sch_SourcePrimitiveComponent.add({
    projectId: projUuid, schematicName, pageName,
    libraryUuid: dev.libraryUuid, name: dev.name,
    x: 100 + i * 120, y: 200,
  });
  if (!r?.ok) { log('addFail', r); continue; }
  const g = await eda.sch_SourcePrimitiveComponent.get({
    projectId: projUuid, schematicName, pageName, primitiveId: r.value.primitiveId });
  comps.push({ des: r.value.designator, primitiveId: r.value.primitiveId, pins: g.value.pins });
}
log('comps', comps.map(c => ({ des: c.des, pins: c.pins.map(p => `${p.pinNumber}@(${p.x},${p.y})`) })));

// 用 net flag 把三个电容的 pin1 全部接到 VTEST，pin2 全部接 GND
const flags = [];
for (const c of comps) {
  for (const pin of c.pins) {
    const isPin1 = String(pin.pinNumber) === '1';
    const net = isPin1 ? 'VTEST' : 'GND';
    const type = isPin1 ? 'Power' : 'Ground';
    // 电源符号 rotation=0 时朝上、引脚在下 → 锚点放在引脚上方 20
    // 地符号 rotation=0 时朝下、引脚在上 → 锚点放在引脚下方 20
    const ny = isPin1 ? pin.y + 20 : pin.y - 20;
    try {
      const r = await eda.sch_SourcePrimitiveComponent.addNetFlag({
        projectId: projUuid, schematicName, pageName,
        type, net, x: pin.x, y: ny,
      });
      flags.push({ des: c.des, pin: pin.pinNumber, net, ok: !!r?.ok, id: r?.value?.primitiveId });
    } catch (e) { flags.push({ des: c.des, pin: pin.pinNumber, net, err: String(e && e.message) }); }
  }
}
log('flags', flags);
await eda.sch_SourceDocument.waitForPersistReady(projUuid, 60000);
await sleep(2500);

// 验证：打开图页读网表
await eda.dmt_EditorControl.openDocument(pageUuid);
await eda.dmt_EditorControl.waitForDocumentReady(pageUuid, 90000);
await sleep(2000);

let netlist = null;
try { netlist = await eda.sch_Netlist.getNetlist(); } catch (e) { log('netlistErr', String(e && e.message)); }

// 解析每个器件的 pin net
const summary = [];
if (netlist) {
  try {
    const nl = typeof netlist === 'string' ? JSON.parse(netlist) : netlist;
    for (const [uid, c] of Object.entries(nl.components || {})) {
      const des = c.props?.Designator;
      const pins = {};
      for (const [pn, pi] of Object.entries(c.pinInfoMap || {})) pins[pn] = pi.net || '(none)';
      summary.push({ des, uid, pins });
    }
  } catch (e) { log('parseErr', String(e && e.message)); }
}
log('netlistSummary', summary);

// DRC
try { log('schDrc', await eda.sch_Drc.check()); } catch (e) { log('drcErr', String(e && e.message)); }

return { projectUuid: projUuid, pageUuid, schematicName, pageName, comps: comps.map(c => ({ des: c.des, primitiveId: c.primitiveId, pins: c.pins })), summary, L };
