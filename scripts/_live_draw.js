// 真·画图演示：在 GUI 里从零建工程，逐个放器件、逐条拉线，全程可见。
// 这是用户要的「AI 一步步画图」——不是回放已有工程。
// args: { designPath, stepMs, maxParts }

async function main() {
  const r = { steps: [] };
  const t0 = Date.now();
  const log = (k, v) => { r.steps.push({ k, v, t: Date.now() - t0 }); };
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));

  const D = __CLI__.args || {};
  const stepMs = D.stepMs || 700;

  // ---------- 1. 建工程 ----------
  let projUuid = null;
  const nm = 'AI_LIVE_' + Date.now().toString(36);
  for (let i = 0; i < 3 && !projUuid; i++) {
    try {
      const u = await eda.dmt_Project.createProject(nm + (i ? '_' + i : ''), null, null, null, 'AI 现场绘制演示');
      if (typeof u === 'string' && u.length > 20) projUuid = u;
    } catch (e) { log('createErr', String(e && e.message).slice(0, 100)); }
    if (!projUuid) await wait(800);
  }
  if (!projUuid) { log('err', 'createProject failed'); return r; }
  log('project', projUuid);
  await eda.dmt_Project.openProject(projUuid);
  await eda.dmt_Project.waitForReady(projUuid, 120000);
  await wait(stepMs);

  // ---------- 2. 建 Board（自动带原理图页 + PCB）----------
  let board = null;
  for (let i = 0; i < 5 && !board; i++) {
    await eda.dmt_Board.createBoard();
    await wait(1500);
    await eda.dmt_Project.waitForReady(projUuid, 120000);
    const bs = await eda.dmt_Board.getAllBoardsInfo();
    if (bs?.length && bs[0].schematic?.page?.length && bs[0].pcb) board = bs[0];
  }
  if (!board) { log('err', 'no board'); return r; }
  const schName = board.schematic.name;
  const pageName = board.schematic.page[0].name;
  const pageUuid = board.schematic.page[0].uuid;
  log('board', { schName, pageName });

  // 打开原理图页并等就绪（这一步必须在放器件前）
  await eda.dmt_EditorControl.openDocument(pageUuid);
  await eda.dmt_EditorControl.waitForDocumentReady(pageUuid, 120000);
  await eda.sch_SourceDocument.waitForPersistReady(projUuid, 120000);
  await wait(stepMs);
  log('ready', 'sch');

  // ---------- 3. 读取设计（直接用 args 传入，避免 CLI 沙箱的文件 IO）----------
  const design = D.design;
  if (!design || !design.components) { log('err', 'no design in args'); return r; }
  log('design', { name: design.name, comps: design.components.length, conns: design.connections.length });

  // ---------- 4. 逐个放器件（每个都停留，肉眼可见）----------
  const placed = [];
  for (let i = 0; i < design.components.length; i++) {
    const item = design.components[i];
    // 查器件
    let dev = null;
    try {
      const list = await eda.lib_Device.getByLcscIds([item.lcsc]);
      dev = Array.isArray(list) ? list[0] : null;
    } catch (e) { log('lookupErr', item.des); }
    if (!dev) { log('noDev', item.des); continue; }

    // 按行列摆开，间距足够大避免符号压叠
    const col = i % 4;
    const row = Math.floor(i / 4);
    const cx = 220 + col * 230;
    const cy = 200 + row * 230;

    try {
      const props = {};
      if (item.value) props.Value = String(item.value);
      const res = await eda.sch_SourcePrimitiveComponent.add({
        projectId: projUuid, schematicName: schName, pageName,
        libraryUuid: dev.libraryUuid, name: dev.name,
        x: cx, y: cy, designator: item.des,
        ...(Object.keys(props).length ? { properties: props } : {}),
      });
      if (res?.ok) {
        placed.push({ des: item.des, primId: res.value.primitiveId, x: cx, y: cy });
        log('add', item.des + '@' + cx + ',' + cy);
      } else {
        log('addFail', item.des);
      }
    } catch (e) { log('addErr', item.des + ':' + String(e && e.message).slice(0, 80)); }
    await wait(stepMs);
  }
  log('placedTotal', placed.length);

  await eda.sch_SourceDocument.waitForPersistReady(projUuid, 120000);
  await wait(stepMs);

  // ---------- 5. 逐条拉线（这就是「画线」的过程）----------
  // 先取每个已放器件的引脚绝对坐标
  const pinAbs = {};
  for (const p of placed) {
    try {
      const g = await eda.sch_SourcePin.getGeometry({
        projectId: projUuid, schematicName: schName, pageName, primitiveId: p.primId });
      if (g?.ok && Array.isArray(g.value)) {
        pinAbs[p.des] = {};
        for (const it of g.value) pinAbs[p.des][String(it.pinNumber)] = it;
      }
    } catch (e) { log('geoErr', p.des); }
  }

  const drawLimit = D.maxWires || 999;
  let drew = 0;
  for (const [des, pinKey, net] of design.connections) {
    if (drew >= drawLimit) break;
    const geo = pinAbs[des]?.[String(pinKey)];
    if (!geo) { log('noPin', des + '.' + pinKey); continue; }
    const stub = 22;
    let ex = geo.x, ey = geo.y;
    if (geo.side === 'left') ex = geo.x - stub;
    else if (geo.side === 'right') ex = geo.x + stub;
    else if (geo.side === 'top') ey = geo.y + stub;
    else if (geo.side === 'bottom') ey = geo.y - stub;
    else ex = geo.x + stub;
    const horiz = (geo.side === 'left' || geo.side === 'right');
    const rot = horiz ? (geo.side === 'left' ? 90 : 270) : 0;
    const up = String(net).toUpperCase();
    const type = (up.startsWith('GND') || up === 'VSS') ? 'Ground' : 'Power';

    try {
      await eda.sch_SourcePrimitiveWire.add({
        projectId: projUuid, schematicName: schName, pageName,
        line: [geo.x, geo.y, ex, ey], net });
      await eda.sch_SourcePrimitiveComponent.addNetFlag({
        projectId: projUuid, schematicName: schName, pageName,
        type, net, x: ex, y: ey, rotation: rot });
      drew++;
      if (drew % 3 === 0) log('wire', des + '.' + pinKey + '->' + net);
    } catch (e) { log('wireErr', des + '.' + pinKey); }
    await wait(stepMs);
  }
  log('wiresTotal', drew);

  await eda.sch_SourceDocument.waitForPersistReady(projUuid, 120000);
  await wait(stepMs * 2);

  // ---------- 6. 镜头拉全图收尾 ----------
  try { await eda.dmt_EditorControl.zoomToAllPrimitives(); log('zoomAll', 'ok'); } catch (e) {}
  await wait(stepMs * 2);

  log('projectUuid', projUuid);
  log('done', 'ok');
  return r;
}
return await main();
