// 最小复现：只连 XTAL_IN 这个网络，看它是否会变成 GND。
// 背景：d11 里 XTAL_IN 的 4 个连接点全部落到 GND，而同板的 XTAL_OUT/RTC_XIN/RTC_OUT/RUN 都正常。
// 假设：网络名以 _IN 结尾，或名字被某些归一化规则影响。逐个改名试。
const fs = require('fs');

async function main() {
  const r = { steps: [] };
  const log = (k, v) => { r.steps.push({ k, v }); };

  // 打开一个测试工程
  let projUuid = null;
  for (let i = 0; i < 3; i++) {
    const nm = 'AI_NETTEST_' + Date.now().toString(36) + '_' + i;
    const u = await eda.dmt_Project.createProject(nm, '', '');
    if (typeof u === 'string' && u.length > 20) { projUuid = u; break; }
  }
  if (!projUuid) { log('err', 'createProject failed'); return r; }
  log('projUuid', projUuid);

  const schUuid = await eda.dmt_Schematic.createSchematic(projUuid, 'S1');
  const pageUuid = await eda.dmt_Schematic.createSchematicPage(projUuid, schUuid, 'P1');
  await eda.dmt_EditorControl.openDocument(pageUuid);
  await eda.sch_SourceDocument.waitForPersistReady(projUuid, 60000);

  // 放一个 2 脚器件（电容），用两个不同网络名各连一次，对比结果
  const lcsc = 'C1548'; // 15pF 0402
  const list = await eda.lib_Device.getByLcscIds([lcsc]);
  const dev = Array.isArray(list) ? list[0] : null;
  if (!dev) { log('err', 'device not found'); return r; }

  const added = await eda.sch_SourcePrimitiveComponent.add({
    projectId: projUuid, schematicName: 'S1', pageName: 'P1',
    deviceUuid: dev.uuid, libraryUuid: dev.libraryUuid,
    x: 200, y: 200, rotation: 0, mirror: false,
    properties: { Value: '15pF' },
  });
  if (!added?.ok) { log('addErr', JSON.stringify(added).slice(0, 200)); return r; }
  const primId = added.value?.primitiveId || added.value;
  log('primId', String(primId).slice(0, 40));

  const g = await eda.sch_SourcePin.getGeometry({
    projectId: projUuid, schematicName: 'S1', pageName: 'P1', primitiveId: primId });
  const pins = (g?.ok && Array.isArray(g.value)) ? g.value : [];
  log('pins', pins.map((p) => ({ n: p.pinNumber, side: p.side, x: p.x, y: p.y })));
  if (pins.length < 2) { log('err', 'need 2 pins'); return r; }

  // 试多个候选网络名，看哪个会落到 GND
  const names = ['XTAL_IN', 'XTALIN', 'XIN_A', 'OSC_IN_TEST', 'CLKIN'];
  for (let i = 0; i < names.length && i < 2; i++) {
    const net = names[i];
    const p = pins[i];
    const stub = 20;
    const ex = p.side === 'left' ? p.x - stub : (p.side === 'right' ? p.x + stub : p.x);
    const ey = p.side === 'top' ? p.y + stub : (p.side === 'bottom' ? p.y - stub : p.y);
    const horizontal = (p.side === 'left' || p.side === 'right');
    const rotation = horizontal ? (p.side === 'left' ? 90 : 270) : 0;

    try {
      await eda.sch_SourcePrimitiveWire.add({
        projectId: projUuid, schematicName: 'S1', pageName: 'P1',
        line: [p.x, p.y, ex, ey], net });
      await eda.sch_SourcePrimitiveComponent.addNetFlag({
        projectId: projUuid, schematicName: 'S1', pageName: 'P1',
        type: 'Power', net, x: ex, y: ey, rotation });
    } catch (e) { log('connErr_' + net, String(e && e.message).slice(0, 120)); }
  }

  await eda.sch_SourceDocument.waitForPersistReady(projUuid, 60000);
  await new Promise((res) => setTimeout(res, 2000));

  const nl = JSON.parse(await eda.sch_Netlist.getNetlist());
  for (const c of Object.values(nl.components || {})) {
    const pins2 = {};
    for (const [pn, pi] of Object.entries(c.pinInfoMap || {})) pins2[pn] = pi.net || '';
    log('nets_' + (c.props?.Designator || '?'), pins2);
  }
  return r;
}
return await main();
