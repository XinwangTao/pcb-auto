// ============================================================
// pcb-auto 全流程 v3 —— 设计只给 LCSC 编号，运行时解析器件
// 输入 __CLI__.args:
//   design : {
//     name, friendly, boardWidthMil, boardHeightMil,
//     components: [{ des, lcsc, value? }],
//     connections: [[des, pinKey, net], ...]
//   }
//   outDir
// ============================================================
const L = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const A = __CLI__.args;
const log = (s, v) => L.push(v === undefined ? { s } : { s, v });
const T0 = Date.now();
const phase = n => log('PHASE', { n, ms: Date.now() - T0 });

// ---------- 总预算：外部 invoke --timeout 的镜像 ----------
// 外部 CLI 的 --timeout 到期**不会**中断 render 里的代码，CLI 原文是
// "gave up waiting; the code may still be running in the render, and its result will be
//  discarded"。所以必须让流水线自己在外层掐断之前收尾并 return；否则留下幽灵调用，
// 紧接着的下一次 invoke 撞上它 → 非 JSON（REQUEST_TIMEOUT / SESSION_CLOSED）→
// run-all 报「输出不是 JSON」，一个设计超时会把后面所有设计拖成「无声失败、策略=?」。
// run-all.ps1 传 budgetMs（= --timeout - 60s），缺省 530000 与 590000 对齐。
const BUDGET = Number((A && A.budgetMs) || 530000);
const left = () => BUDGET - (Date.now() - T0);
log('budget', { totalMs: BUDGET });

// 录屏模式（args.recordMode）：让录制画面始终能看清 AI 在做什么。
//
// 踩过的三个坑（都实测过，别再走回头路）：
//  1) 只调用 zoomToAllPrimitives 不够——placeParts/connect 期间前台文档是 PCB，
//     原理图在后台被 API 修改，画面停在**空白 PCB 画布**上，录出来是死画面。
//  2) activateDocument 也不行——实测画面依旧空白，而且把 connect 阶段从 9s 拖到 128s。
//  3) 唯一可靠的是 tileAllDocumentToSplitScreen()：原理图和 PCB **上下分屏同时可见**，
//     原理图里能看到器件和连线逐步出现，PCB 里能看到布局/铺铜/布线逐步完成。
//     开销只有约 2.5s，一次调用即可长期保持。
const REC = !!(A && A.recordMode);
const DOC = { sch: null, pcb: null };
let splitDone = false;
// force: 是否强制 openDocument 切换激活文档。
//   - 原理图侧全程不需要（分屏里原理图一直可见，且它只是被 API 写入）
//   - PCB 侧只在真正要驱动编辑器动作前后需要一次（布线前后），否则布线结果不落盘
// 实测：每次 openDocument 额外 3–8s；高频调用把 connect 从 9s 拖到 127s，
// 而完全不用 openDocument 会让 DRC 报 23 处 Connection Error。所以只在关键点强制。
async function cam(what, force) {
  if (!REC) return;
  try {
    if (!splitDone) {
      // 分屏前必须让**两个文档都已打开**，否则 tileAllDocumentToSplitScreen 只对
      // 当前一个文档生效（画面仍是单屏，且原理图侧录不到任何内容）。
      // 打开顺序：先 PCB 再原理图，最后回 PCB（PCB 是后续布局/布线的作用对象）。
      if (DOC.pcb) {
        await eda.dmt_EditorControl.openDocument(DOC.pcb);
        await eda.dmt_EditorControl.waitForDocumentReady(DOC.pcb, 60000);
      }
      if (DOC.sch) {
        await eda.dmt_EditorControl.openDocument(DOC.sch);
        await eda.dmt_EditorControl.waitForDocumentReady(DOC.sch, 60000);
      }
      await eda.dmt_EditorControl.tileAllDocumentToSplitScreen();
      await sleep(1500);
      splitDone = true;
      log('cam', 'split', { opened: !!(DOC.pcb && DOC.sch) });
    }
    if (force) {
      const uuid = DOC[what];
      if (uuid) {
        await eda.dmt_EditorControl.openDocument(uuid);
        await eda.dmt_EditorControl.waitForDocumentReady(uuid, 30000);
        await sleep(250);
      }
    }
    if (what === 'pcb') await eda.pcb_Document.zoomToBoardOutline();
    else {
      // 原理图：只需 fit 全图。注意**不要**再叠 zoomToRegion——它的坐标语义未验证，
      // 传大矩形等于缩到极小（拍到一片空白）。绘图区本身已随录制分辨率提到
      // 1920x1200 而放大约 2.25 倍，细节足够。
      await eda.dmt_EditorControl.zoomToAllPrimitives();
    }
    log('cam', what);
  } catch (e) { /* 相机失败不影响主流程 */ }
  await sleep(150);
}

const D = A.design;
const OUT = A.outDir;
// 工程名必须唯一：同名已存在时 createProject 会静默返回 undefined（不抛错）
const friendly = (D.friendly || ('AI_' + (D.name || 'Board'))) + '_' + Date.now().toString(36);
const errors = [];
const warns = [];
const artifacts = [];

async function waitDoc(uuid, ms = 120000) {
  await eda.dmt_EditorControl.openDocument(uuid);
  await eda.dmt_EditorControl.waitForDocumentReady(uuid, ms);
}
async function waitJob(jobId, maxMs = 600000) {
  const t = Date.now();
  while (Date.now() - t < maxMs) {
    let st = null;
    try { st = await eda.pcb_Document.getAutoJobStatus(jobId); }
    catch (e) { return { state: 'ERR', err: String(e && e.message) }; }
    const s = String(st?.state ?? st?.status ?? '').toLowerCase();
    if (['completed', 'failed', 'cancelled', 'canceled'].includes(s)) return { state: s, st, ms: Date.now() - t };
    await sleep(1200);
  }
  return { state: 'TIMEOUT', ms: Date.now() - t };
}
function toBlob(d) {
  if (d instanceof Blob) return d;
  if (typeof d === 'string') return new Blob([d]);
  return new Blob([JSON.stringify(d)]);
}

// ---------- 0. 解析器件（唯一可信来源）----------
phase('resolveParts');
const lcscList = [...new Set(D.components.map(c => c.lcsc))];
const devs = await eda.lib_Device.getByLcscIds(lcscList);
const byLcsc = {};
for (const d of (devs || [])) {
  const p = d.otherProperty || {};
  byLcsc[p['Supplier Part']] = {
    lcsc: p['Supplier Part'],
    name: d.name,
    value: p.Value || p['Manufacturer Part'] || d.name,
    klass: p['JLCPCB Part Class'],
    mfr: p['Manufacturer'],
    datasheet: p['Datasheet'],
    footprint: p['Supplier Footprint'],
    symbolUuid: d.symbolUuid,
    footprintUuid: d.footprintUuid,
    libraryUuid: d.libraryUuid,
  };
}
log('resolvedParts', byLcsc);
for (const c of D.components) {
  if (!byLcsc[c.lcsc]) errors.push(`unresolved lcsc ${c.lcsc} for ${c.des}`);
  // 社区上传件（无原厂/datasheet）常见于连接器/定制件：不阻断流程，但记入 warns 供人工复核。
  // 只有「查不到器件」才是致命错误（无法取 symbol/footprint，流程根本跑不下去）。
  else if (!byLcsc[c.lcsc].mfr && !byLcsc[c.lcsc].datasheet) {
    warns.push(`low-trust part ${c.lcsc} for ${c.des} (社区上传件，无原厂/datasheet，下单前建议人工复核)`);
  }
}
if (errors.some(e => e.startsWith('unresolved'))) {
  return { ok: false, stage: 'resolveParts', errors, log: L };
}

// ---------- 1. 建工程 ----------
phase('createProject');
let projectUuid = null;
for (let i = 0; i < 5 && !projectUuid; i++) {
  // 每次重试都用新名字，避免同名静默返回 undefined
  const nm = friendly + (i ? '_r' + i : '');
  try {
    const u = await eda.dmt_Project.createProject(nm, null, null, null, 'AI 全自动生成：' + (D.name || ''));
    if (typeof u === 'string' && u.length > 20) { projectUuid = u; log('projectName', nm); }
    else { log('createProjectEmpty', { attempt: i, name: nm, got: String(u) }); }
  } catch (e) { log('createProjectErr', { attempt: i, m: String(e && e.message) }); }
  if (!projectUuid) await sleep(1200);
}
if (!projectUuid) throw new Error('createProject failed after 5 attempts');
await eda.dmt_Project.openProject(projectUuid);
await sleep(2000);
await eda.dmt_Project.waitForReady(projectUuid, 60000);
log('projectUuid', projectUuid);

// ---------- 2. 建 Board ----------
phase('createBoard');
let board = null;
let boardsCreated = 0;
const existingBoards = (await eda.dmt_Board.getAllBoardsInfo()) || [];
log('boardInventoryStart', { count: existingBoards.length,
  names: existingBoards.map(b => b.name) });
for (let i = 0; i < 8 && !board; i++) {
  let bs = (await eda.dmt_Board.getAllBoardsInfo()) || [];
  if (bs.length === 0 && boardsCreated === 0) {
    // 只有**真没抛异常**才算建过。原实现 `createBoard()` 后立刻 boardsCreated++，
    // 一次静默失败就永久停手，之后 8 轮 × 2 次 waitForReady 白等（远超外部 590s 掐断线），
    // 连「no board」都报不出来。
    try {
      await eda.dmt_Board.createBoard();    // 全程仅此一处建板
      boardsCreated++;
      log('boardCreated', { attempt: i });
    } catch (e) {
      log('boardCreateErr', { attempt: i, m: String(e && e.message).slice(0, 120) });
      await sleep(1500);
      continue;                            // 没建成就还能再试，不消耗建板配额
    }
  } else {
    // 已有板（或用例刚建）→ 等工程树异步刷新，绝不再建
    await eda.dmt_Project.waitForReady(projectUuid, 60000);
  }
  await sleep(2200);
  await eda.dmt_Project.waitForReady(projectUuid, 60000);
  bs = (await eda.dmt_Board.getAllBoardsInfo()) || [];
  // 取**第一块同时有原理图页和 PCB** 的板，而不是盲取 bs[0]
  board = bs.find(b => b.schematic?.page?.length && b.pcb) || null;
  if (!board) log('boardWait', { attempt: i, boards: bs.length,
    states: bs.map(b => ({ n: b.name, pages: b.schematic?.page?.length, pcb: !!b.pcb })) });
}
if (!board) throw new Error('no board');
log('boardsCreated', boardsCreated);
const allPcbs = (await eda.dmt_Pcb.getAllPcbsInfo()) || [];
log('pcbInventory', { count: allPcbs.length,
  pcbs: allPcbs.map(p => ({ name: p.name, uuid: p.uuid })) });
if (allPcbs.length > 1) {
  log('pcbDuplicateWarn', { count: allPcbs.length,
    msg: '工程里有多块 PCB，后续一律用 board.pcb.uuid 而非 getAllPcbsInfo()[0]' });
}
const schName = board.schematic.name;
const pageName = board.schematic.page[0].name;
const pageUuid = board.schematic.page[0].uuid;
const schUuid = board.schematic.uuid;
const pcbUuid = board.pcb.uuid;
DOC.sch = schUuid;
DOC.pcb = pcbUuid;
log('board', { name: board.name, schName, pageName, pageUuid, schUuid, pcbUuid });

// ---------- 3. 放器件 ----------
// 网格布局：标准图页约 1200x900 mil（A4 横向），一字排开会超出页面触发
// OBJECTOUTSIDESHEET 警告。列数随器件数放大（最多 7 列），避免器件多时纵向溢出。
await cam('sch');   // 放件前原理图全图
phase('placeParts');
const placed = [];
const nComp = D.components.length;

// 关键修复：布局必须按每个符号的**真实包围盒**排，不能用固定格子。
// 之前固定 DX=160/DY=150，而 RP2040 符号约 250x260、ESP32-WROOM 约 140x280，
// 大符号会压进相邻器件的区域，导致新加的网络标志落在别人的 GND 引脚桩上，
// 整条网络被并进 GND（d11 的 XTAL_IN 4 点全变 GND 就是这么来的）。
// 现在先查 symbol 几何，取半宽/半高参与排版，符号之间留 GAP。
const GAP = 70;          // 符号边缘间距（mil）
const SHEET_W = 1050;    // 单页可用宽度
const extents = [];      // 每个器件的 {hw, hh}
for (let i = 0; i < D.components.length; i++) {
  const part = byLcsc[D.components[i].lcsc];
  let hw = 40, hh = 30;   // 查不到几何时的保守默认值
  try {
    const geo = await eda.lib_Symbol.getGeometry(part.symbolUuid, part.libraryUuid);
    const bb = geo?.bodyBBox || geo?.fullBBox;
    // bodyBBox 形如 {x,y,width,height}；pins 里也带绝对坐标，取两者最大值兜底
    if (bb && isFinite(bb.width) && isFinite(bb.height)) {
      hw = Math.max(hw, Math.abs(bb.width) / 2);
      hh = Math.max(hh, Math.abs(bb.height) / 2);
    }
    for (const p of (geo?.pins || [])) {
      const px = Math.abs(p.x ?? 0), py = Math.abs(p.y ?? 0);
      hw = Math.max(hw, px + 20);   // 引脚端点也要算进来
      hh = Math.max(hh, py + 20);
    }
  } catch (e) { /* 用默认值 */ }
  extents.push({ hw, hh });
}
log('symbolExtents', D.components.map((c, i) => ({ des: c.des, hw: Math.round(extents[i].hw), hh: Math.round(extents[i].hh) })));

// 行式排版：逐行填，放不下就换行；每行高度取该行最高符号
const positions = [];
let curX = 100, curY = 120, rowH = 0;
for (let i = 0; i < extents.length; i++) {
  const { hw, hh } = extents[i];
  const w = hw * 2 + GAP;
  if (curX > 100 && (curX + w - 100) > SHEET_W) {
    curX = 100;
    curY += rowH + GAP;
    rowH = 0;
  }
  positions.push({ x: Math.round(curX + hw), y: Math.round(curY + hh) });
  curX += w;
  rowH = Math.max(rowH, hh * 2);
}
log('placePositions', positions.map((p, i) => ({ des: D.components[i].des, x: p.x, y: p.y })));

for (let i = 0; i < D.components.length; i++) {
  const item = D.components[i];
  const part = byLcsc[item.lcsc];
  const cx = positions[i].x;
  const cy = positions[i].y;
  let r = null;
  try {
    const props = {};
    if (item.value) props.Value = String(item.value);
    r = await eda.sch_SourcePrimitiveComponent.add({
      projectId: projectUuid, schematicName: schName, pageName,
      libraryUuid: part.libraryUuid, name: part.name,
      x: cx, y: cy, designator: item.des,
      ...(Object.keys(props).length ? { properties: props } : {}),
    });
  } catch (e) { errors.push(`add ${item.des}: ${e && e.message}`); continue; }
  if (!r?.ok) { errors.push(`add ${item.des}: ${JSON.stringify(r)}`); continue; }
  const g = await eda.sch_SourcePrimitiveComponent.get({
    projectId: projectUuid, schematicName: schName, pageName, primitiveId: r.value.primitiveId });
  placed.push({ des: r.value.designator, lcsc: item.lcsc, primitiveId: r.value.primitiveId,
    pins: g.value.pins, props: g.value.properties });
}
log('placed', placed.map(p => ({ des: p.des, lcsc: p.lcsc,
  pins: p.pins.map(x => `${x.pinNumber}:${x.pinName}`) })));
if (!placed.length) throw new Error('no parts placed');
await eda.sch_SourceDocument.waitForPersistReady(projectUuid, 60000);
await sleep(1200);

// ---------- 4. 连通 ----------
// 关键：必须按引脚所在边(side)引出，否则同边多引脚会走线重叠被合并成同一网络
await cam('sch');   // 连接前原理图全图
phase('connect');
const pinGeo = {};   // primitiveId -> { pinNumber: {side,length,x,y} }
for (const p of placed) {
  try {
    const g = await eda.sch_SourcePin.getGeometry({
      projectId: projectUuid, schematicName: schName, pageName, primitiveId: p.primitiveId });
    if (g?.ok && Array.isArray(g.value)) {
      pinGeo[p.primitiveId] = {};
      for (const item of g.value) {
        pinGeo[p.primitiveId][String(item.pinNumber)] = item;
      }
    }
  } catch (e) { log('pinGeoErr', { des: p.des, m: String(e && e.message) }); }
}
log('pinGeoSample', pinGeo[placed[0]?.primitiveId] ? Object.entries(pinGeo[placed[0].primitiveId])
  .slice(0, 4).map(([k, v]) => ({ n: k, side: v.side, len: v.length, x: v.x, y: v.y })) : null);

function findPinCtx(des, key) {
  const c = placed.find(p => p.des === des);
  if (!c) return null;
  const k = String(key);
  const pin = c.pins.find(p => String(p.pinNumber) === k)
    || c.pins.find(p => String(p.pinName).toUpperCase() === k.toUpperCase())
    || null;
  if (!pin) return null;
  const geo = pinGeo[c.primitiveId]?.[String(pin.pinNumber)] || null;
  return { c, pin, geo };
}

const connSteps = [];
const connList = D.connections || [];
for (let ci = 0; ci < connList.length; ci++) {
  const [des, pinKey, net] = connList[ci];
  const ctx = findPinCtx(des, pinKey);
  if (!ctx) { errors.push(`pin missing ${des}.${pinKey}`); continue; }
  const { pin, geo } = ctx;
  const up = String(net).toUpperCase();
  const isGnd = up.startsWith('GND') || up === 'VSS';
  const type = isGnd ? 'Ground' : 'Power';

  // 按 side 决定引出方向；没有 side 时退化为用符号几何推断
  const side = geo?.side || 'left';
  const stub = 20;
  let ex = pin.x, ey = pin.y;
  if (side === 'left') ex = pin.x - stub;
  else if (side === 'right') ex = pin.x + stub;
  else if (side === 'top') ey = pin.y + stub;
  else if (side === 'bottom') ey = pin.y - stub;
  else ex = pin.x + stub;

  // 网络符号放在引出线端点；rotation 由符号方向决定
  //  - 引出线水平（left/right）→ 符号需旋转 90/270 使引脚朝向器件
  //  - 引出线垂直（top/bottom）→ rotation 0（电源朝上/地朝下）
  const horizontal = (side === 'left' || side === 'right');
  let rotation = 0;
  if (horizontal) rotation = (side === 'left') ? 90 : 270;
  else rotation = (isGnd ? 0 : 180);   // 引脚在下方(向上引出)→180；向下引出→0

  let wireOk = false, flagOk = false;
  try {
    const w = await eda.sch_SourcePrimitiveWire.add({
      projectId: projectUuid, schematicName: schName, pageName,
      line: [pin.x, pin.y, ex, ey], net });
    wireOk = !!w?.ok;
  } catch (e) { errors.push(`wire ${des}.${pinKey}: ${e && e.message}`); }
  try {
    const f = await eda.sch_SourcePrimitiveComponent.addNetFlag({
      projectId: projectUuid, schematicName: schName, pageName,
      type, net, x: ex, y: ey, rotation });
    flagOk = !!f?.ok;
  } catch (e) { errors.push(`flag ${des}.${pinKey}: ${e && e.message}`); }
  connSteps.push({ des, pinKey, net, side, seg: [pin.x, pin.y, ex, ey], rotation, wireOk, flagOk });
}
log('connect', { total: connSteps.length,
  wireFail: connSteps.filter(c => !c.wireOk).length,
  flagFail: connSteps.filter(c => !c.flagOk).length });
await eda.sch_SourceDocument.waitForPersistReady(projectUuid, 60000);
await sleep(1800);

// ---------- 5. 网表校验 + 原理图 DRC ----------
await cam('sch');   // 网表核对前回原理图全图
phase('netlistCheck');
let netSummary = null, schDrc = null, mismatches = [];
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
  for (const [des, pinKey, net] of (D.connections || [])) {
    const row = netSummary.find(r => r.des === des);
    if (!row) { mismatches.push({ des, pinKey, want: net, got: 'NO_COMP' }); continue; }
    const got = row.pins[String(pinKey)] ?? row.pins[pinKey];
    if (String(got).toUpperCase() !== String(net).toUpperCase()) mismatches.push({ des, pinKey, want: net, got });
  }
  log('netMismatches', mismatches);
} catch (e) { errors.push('netlist: ' + (e && e.message)); }
// 原理图 DRC：strict=true 时 warning 也算不通过（未连接引脚 CHECKFLOATPIN 就是 warn）。
// 官方文档明确说明这是预期行为，因此这里按 type 分级：fatalError/error 才算真错。
let schDrcViolations = [], schDrcErrors = 0, schDrcWarns = 0;
try {
  await waitDoc(pageUuid, 90000);
  const raw = await eda.sch_Drc.check(true, false, true);
  schDrcViolations = Array.isArray(raw) ? raw : [];
  for (const v of schDrcViolations) {
    if (v?.type === 'fatalError' || v?.type === 'error') schDrcErrors++;
    else schDrcWarns++;
  }
  schDrc = schDrcErrors === 0;
  log('schDrc', { errors: schDrcErrors, warns: schDrcWarns,
    rules: [...new Set(schDrcViolations.map(v => v?.rule))] });
} catch (e) { errors.push('schDrc: ' + (e && e.message)); }

// ---------- 6. PCB 导入 + 板框 ----------
phase('pcbImport');
await waitDoc(pcbUuid, 120000);
await sleep(1200);
await cam('pcb', true);   // 强制激活 PCB：后续 importChanges/布局都作用于它
let imported = false;
let outlineOk = false;
for (let i = 0; i < 4 && !imported; i++) {
  try { imported = await eda.pcb_Document.importChanges(schUuid, true); } catch (e) { }
  if (!imported) await sleep(2000);
}
log('importChanges', imported);
await sleep(1800);

// ---------- 6.5 先按设计意图画板框（布局引擎需要板框才正常摆放）----------
// 关键：板框必须在 autoLayout **之前**存在。没有板框时布局引擎把器件压成细长条，
// 布线器随后直接放弃（1.2s "completed" 但零铜）。
const bw0 = D.boardWidthMil || 1000, bh0 = D.boardHeightMil || 800;
let outlineInfo = null;
// 板框填充率：实际器件占用面积 / 板框面积。低于 0.5 说明初始板框估大了，
// 外层可用更小的初始板框重跑（必须在布局**之前**缩小，布局后剪会毁布线）。
let outlineFillRatio = null;
try {
  const poly = eda.pcb_MathPolygon.createPolygon(['R', 0, 0, bw0, bh0, 0, 0]);
  outlineOk = !!(await eda.pcb_PrimitivePolyline.create('', 11, poly, 10, false));
  outlineInfo = { w: bw0, h: bh0, stage: 'preLayout' };
} catch (e) { errors.push('outline: ' + (e && e.message)); }
log('outline0', { ok: outlineOk, ...outlineInfo });

// ---------- 7. 自动布局 ----------
await cam('pcb');   // 布局前全板视图
phase('autoLayout');
let layoutState = null;
try {
  const job = await eda.pcb_Document.startAutoLayout();
  if (job?.jobId) { const r = await waitJob(job.jobId, 420000); layoutState = r.state; log('layout', r); }
} catch (e) { errors.push('autoLayout: ' + (e && e.message)); }
await sleep(1500);

// ---------- 7.2 板框复核：仅当布局结果真的超出板框时才扩大 ----------
// 已验证：布局前固定板框 (0,0,bw,bh) 能正常布局+布线（d1/d2/d3 全部 DRC 零违规）。
// 只有连接器过大导致器件跑到板框外时才需要扩板 —— 扩板后必须重建覆铜。
try {
  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity, padN = 0;
  for (const id of (await eda.pcb_PrimitivePad.getAllPrimitiveId()) || []) {
    try {
      const p = await eda.pcb_PrimitivePad.get(id);
      const x = p?.getState_X?.(), y = p?.getState_Y?.();
      if (typeof x !== 'number' || typeof y !== 'number') continue;
      const w = Number(p?.getState_Width?.() || 20), h = Number(p?.getState_Height?.() || 20);
      xMin = Math.min(xMin, x - w / 2); xMax = Math.max(xMax, x + w / 2);
      yMin = Math.min(yMin, y - h / 2); yMax = Math.max(yMax, y + h / 2);
      padN++;
    } catch (e) { }
  }
  // 注意：布局产物常在负 Y（如 -671..-229），这**不是**问题 —— d1/d2/d3 都这样且全部通过。
  // 唯一要判的是"器件范围是否超出板框尺寸"，用尺寸比较，不用绝对坐标比较。
  const spanW = padN > 0 ? (xMax - xMin) : 0;
  const spanH = padN > 0 ? (yMax - yMin) : 0;
  const fits = padN > 0 && spanW <= bw0 - 40 && spanH <= bh0 - 40;
  log('outlineFit', { fits, padN,
    bbox: padN ? [xMin, yMin, xMax, yMax].map(v => Math.round(v)) : null,
    span: [Math.round(spanW), Math.round(spanH)],
    board: [bw0, bh0] });
  if (!fits && padN > 0 && Number.isFinite(xMin)) {
    try {
      for (const id of (await eda.pcb_PrimitivePolyline.getAllPrimitiveId()) || []) {
        const pl = await eda.pcb_PrimitivePolyline.get(id);
        if (pl?.getState_Layer?.() === 11) await eda.pcb_PrimitivePolyline.delete(id);
      }
    } catch (e) { }
    const MARGIN = 60;
    // 只贴合布局跨度会做出细长条板（实测 1220x140 焊盘跨度 -> 1340x260 板），
    // 太薄导致布线绕不开，最终 DRC 断网。改为：按需要放大的那一维求出等比系数，
    // 保持原板框长宽比放大，并保证两维都不小于布局跨度 + 边距。
    const needW = (xMax - xMin) + MARGIN * 2;
    const needH = (yMax - yMin) + MARGIN * 2;
    const baseRatio = bh0 > 0 ? bw0 / bh0 : 1;   // 原始设计意图的长宽比
    // 以原始板框为基准等比放大到刚好容纳 needW/needH 的最小倍数
    let scale = Math.max(needW / Math.max(bw0, 1), needH / Math.max(bh0, 1), 1);
    let ow = Math.ceil(bw0 * scale);
    let oh = Math.ceil(bh0 * scale);
    // 兜底：等比放大后若某一维仍不足，只补该维（避免极端长条形设计被压扁）
    if (ow < needW) ow = Math.ceil(needW);
    if (oh < needH) oh = Math.ceil(needH);
    // 居中对齐到布局中心
    const cx = (xMin + xMax) / 2, cy = (yMin + yMax) / 2;
    const ox = cx - ow / 2, oy = cy - oh / 2;
    log('outlineExpandPlan', { baseTheory: [bw0, bh0], baseRatio: Math.round(baseRatio * 100) / 100,
      need: [Math.round(needW), Math.round(needH)], scale: Math.round(scale * 100) / 100,
      result: [ow, oh] });
    try {
      const poly = eda.pcb_MathPolygon.createPolygon(['R', ox, oy, ow, oh, 0, 0]);
      outlineOk = !!(await eda.pcb_PrimitivePolyline.create('', 11, poly, 10, false));
      outlineInfo = { ox, oy, ow, oh, margin: MARGIN, padN, stage: 'expanded', scale };
    } catch (e) { errors.push('outlineExpand: ' + (e && e.message)); }
    log('outline', { ok: outlineOk, ...outlineInfo });
    await sleep(1200);
  } else if (fits && padN > 0 && Number.isFinite(xMin)) {
    // 板框是**估算**出来的（$estArea），实际布局往往紧凑得多，只扩不缩会留下大片空白。
    // 但实测：布局**之后**再剪板框会毁掉布线 —— 布局引擎按大板框排成细长条
    // （span 717×2167），剪到 1237 宽后扇出空间不足，fixClearance 把走线全删，
    // 68 个网络全部断开。所以这里**只记录不裁剪**，把收缩交给外层用更小的
    // 初始板框重跑一轮（布局阶段就按小板框排，才是对的顺序）。
    const usedArea = spanW * spanH;
    const boardArea = bw0 * bh0;
    const fillRatio = boardArea > 0 ? usedArea / boardArea : 1;
    outlineFillRatio = fillRatio;
    log('outlineFit.fill', {
      usedArea: Math.round(usedArea), boardArea: Math.round(boardArea),
      fillRatio: Math.round(fillRatio * 100) / 100,
      hint: fillRatio < 0.5 ? 'underfilled' : 'ok',
    });
  }
} catch (e) { errors.push('outlineCheck: ' + (e && e.message)); }

// ---------- 7.5 给难连焊盘（如 DFN 中央散热焊盘 EP）预先打过孔 ----------
// 目的：EP 被本体包围，单层走线进不去；先在它上面打过孔，让它直接接到底层 GND 铜
phase('preVia');
let viaCount = 0;
try {
  const padIds = await eda.pcb_PrimitivePad.getAllPrimitiveId();
  const padList = [];
  for (const id of (padIds || [])) {
    try {
      const p = await eda.pcb_PrimitivePad.get(id);
      padList.push({ id, net: p?.getState_Net?.(), x: p?.getState_X?.(), y: p?.getState_Y?.(),
        num: p?.getState_Number?.() });
    } catch (e) { }
  }
  log('padsBeforeVia', padList.map(p => ({ num: p.num, net: p.net, x: p.x, y: p.y })));
  // 只给「被本体包围的」GND 焊盘打过孔（DFN 中央 EP），其余 GND 焊盘走正常布线
  // 判据：同一器件内，该焊盘被其它焊盘的包围盒完全包住
  const gndPads = padList.filter(p => String(p.net).toUpperCase() === 'GND');
  const enclosed = [];
  // 只在焊盘密集的局部窗口里做包围判断，避免 40+ 焊盘时 O(n^2) 全量比较
  for (const g of gndPads) {
    const local = padList.filter(o =>
      o.id !== g.id && Math.abs(o.x - g.x) < 40 && Math.abs(o.y - g.y) < 40);
    if (!local.length) continue;
    const hasUp = local.some(o => o.y > g.y + 15);
    const hasDown = local.some(o => o.y < g.y - 15);
    const hasLeft = local.some(o => o.x < g.x - 15);
    const hasRight = local.some(o => o.x > g.x + 15);
    if ((hasUp && hasDown) || (hasLeft && hasRight)) enclosed.push(g);
  }
  log('enclosedGndPads', enclosed.map(p => ({ num: p.num, x: p.x, y: p.y })));
  for (const g of enclosed) {
    try {
      // 过孔取规则最小值：外径 0.5mm≈19.7mil，孔 0.3mm≈11.8mil
      // DFN 的 EP 焊盘窄，中心打孔会贴近相邻同排焊盘 → 沿"离最近非GND焊盘最远的方向"偏移
      const near = padList
        .filter(o => o.id !== g.id && String(o.net || '').toUpperCase() !== 'GND')
        .map(o => ({ o, d: Math.hypot(o.x - g.x, o.y - g.y) }))
        .sort((a, b) => a.d - b.d)[0];
      let vx = g.x, vy = g.y;
      if (near && near.d < 40) {
        const dx = g.x - near.o.x, dy = g.y - near.o.y;
        const len = Math.hypot(dx, dy) || 1;
        const off = 7;   // 偏移 7mil，留出 6mil 间距余量
        vx = g.x + (dx / len) * off;
        vy = g.y + (dy / len) * off;
      }
      const v = await eda.pcb_PrimitiveVia.create('GND', vx, vy, 11.8, 19.7);
      if (v) viaCount++;
      log('epViaAt', { pad: [g.x, g.y], via: [vx, vy], near: near ? near.d : null });
    } catch (e) { log('viaErr', { at: [g.x, g.y], m: String(e && e.message).slice(0, 120) }); }
  }
  log('epVias', { count: viaCount });
} catch (e) { log('preViaErr', String(e && e.message)); }
await sleep(800);

// ---------- 7.6 整板 GND 覆铜（两层）----------
// 关键：必须用 PCB_PrimitivePour（覆铜边框），不是 PrimitiveFill（填充）。
// 只有覆铜在 rebuildAllCopperRegions() 后会真正生成铜皮并连接同网焊盘。
await cam('pcb');   // 铺铜前全板视图
phase('copperPour');
let pourCount = 0;
try {
  // 从板框 polyline 的 bbox 取实际范围，避免坐标系猜错
  let x0 = 0, y0 = 0, w = D.boardWidthMil || 1000, h = D.boardHeightMil || 800;
  try {
    const plIds = await eda.pcb_PrimitivePolyline.getAllPrimitiveId();
    for (const id of plIds) {
      const pl = await eda.pcb_PrimitivePolyline.get(id);
      if (pl?.getState_Layer?.() !== 11) continue;
      const src = pl?.getState_Polygon?.()?.getSource?.();
      if (Array.isArray(src) && src[0] === 'R') {
        x0 = src[1]; y0 = src[2]; w = src[3]; h = src[4];
        break;
      }
    }
  } catch (e) { log('outlineReadErr', String(e && e.message).slice(0, 120)); }
  const inset = 8;
  log('outlineBBox', { x0, y0, w, h, inset });
  // GND 铺满两层；其余电源网络（VDD/VCC/3V3/5V 等）在顶层单独铺一块小一点的
  const gndPlan = [
    { net: 'GND', layer: 1, inset },
    { net: 'GND', layer: 2, inset },
  ];
  const pwrNets = (D.connections || []).map(c => String(c[2]))
    .filter(n => {
      const u = String(n).toUpperCase();
      return u && !u.startsWith('GND')
        && (u.startsWith('VDD') || u.startsWith('VCC')
            || u === '3V3' || u === '3.3V' || u === '5V' || u.startsWith('+'));
    });
  const uniqPwr = [...new Set(pwrNets)];
  log('powerNets', uniqPwr);
  // 电源网络在顶层铺，内缩更大避免和 GND 抢空间；多于 1 个时逐个加优先级错开
  for (let i = 0; i < uniqPwr.length && i < 2; i++) {
    gndPlan.push({ net: uniqPwr[i], layer: 1, inset: inset + 14 + i * 12, priority: 8 + i });
  }
  for (const plan of gndPlan) {
    try {
      const poly = eda.pcb_MathPolygon.createPolygon(
        ['R', x0 + plan.inset, y0 + plan.inset,
         w - plan.inset * 2, h - plan.inset * 2, 0, 0]);
      const p = await eda.pcb_PrimitivePour.create(
        plan.net, plan.layer, poly, 'solid', false,
        'AI_' + plan.net + '_L' + plan.layer, plan.priority || 5, 8, false);
      if (p) pourCount++;
    } catch (e) { log('pourErr', { net: plan.net, layer: plan.layer, m: String(e && e.message).slice(0, 200) }); }
  }
  log('copperPours', { count: pourCount });
  if (pourCount > 0) {
    try {
      await eda.pcb_PrimitivePour.rebuildAllCopperRegions();
      log('pourRebuilt', true);
    } catch (e) { log('pourRebuildErr', String(e && e.message).slice(0, 200)); }
  }
} catch (e) { log('pourFail', String(e && e.message)); }
await sleep(2500);

// ---------- 8. 自动布线 ----------
// 极速引擎：layers 数组 + 地孔策略；EP(散热焊盘)被本体包围，必须打地过孔才能连出
await cam('pcb', true);   // 强制激活 PCB：否则布线结果不落盘
phase('autoRouting');
let routeState = null, routeAttempts = [];
const baseEngine = {
  layers: [{ id: 1, dir: 'V' }, { id: 2, dir: 'H' }],
  // 地孔策略：给 EP 焊盘自动打孔下到地层
  ground: {
    pattern: 'POUR',
    epVias: { pitch: 30, max: 9 },
  },
  // 整板 GND 正片铺铜（两层都铺）
  pours: [{ layer: 1, net: 'GND' }, { layer: 2, net: 'GND' }],
  // GND 用更宽的线
  classes: [{ name: 'GND', nets: ['GND'], width: 12, priority: 30 }],
};
const variants = [
  { name: 'ground+pours+keep', keep: true, cfg: baseEngine },
  { name: 'ground+keep', keep: true, cfg: { layers: baseEngine.layers, ground: baseEngine.ground, classes: baseEngine.classes } },
  { name: 'keep-only', keep: true, cfg: { layers: baseEngine.layers } },
  { name: 'ground+pours', keep: false, cfg: baseEngine },
  { name: 'plain', keep: false, cfg: { layers: baseEngine.layers } },
];
// 迭代：布线 → DRC → 若有断连则再布一次（keep 模式，保留已有铜只补缺）
// 优化级别：默认 ULTRA_FAST（快）。实测 d6 一上来就用 COMPLETION，
// 反而布不通 → 触发放大板框，最终 3104x2607（比 1925x1617 大 2.6 倍）且耗时翻倍。
// 所以策略是「先快后强」：常规轮次用极速，只有 3 轮变体全军覆没时才动用
// COMPLETION 兜底（那是真的布不通，此时慢也认了）。
const ROUTE_OPT = { FAST: EPCB_AutoRoutingOptimization.ULTRA_FAST, STRONG: EPCB_AutoRoutingOptimization.COMPLETION };
// 主循环 3 轮用 FAST；若 3 轮后仍有断连，再补 1 轮 STRONG（第 4 轮）。
// iter===3 就是那个保底轮次。
for (let iter = 0; iter < 4; iter++) {
  const isStrong = (iter === 3);
  if (isStrong) {
    // 只有在前面所有 FAST 轮次都没能清零断连时才走到这里
    log('routeEscalate', { reason: 'FAST 3 轮后仍有断连，升级 COMPLETION 兜底' });
  }
  for (const v of variants) {
    try {
      const isFirstTry = isStrong;
      const opt = isStrong ? ROUTE_OPT.STRONG : ROUTE_OPT.FAST;
      const job = await eda.pcb_Document.startAutoRouting({
        optimization: opt,
        existingPrimitiveMode: v.keep ? EPCB_AutoRoutingExistingPrimitiveMode.KEEP
                                     : EPCB_AutoRoutingExistingPrimitiveMode.REMOVE,
        engineConfig: v.cfg,
      });
      if (job?.jobId) {
        // COMPLETION 模式布线更彻底、明显更慢，给它 900s；极速模式 600s 足够
        const r = await waitJob(job.jobId, isFirstTry ? 900000 : 600000);
        routeAttempts.push({ iter, variant: v.name, jobId: job.jobId, state: r.state, ms: r.ms });
        routeState = r.state;
        log('route', { iter, variant: v.name, state: r.state, ms: r.ms });
        if (r.state === 'completed') break;
      }
    } catch (e) {
      routeAttempts.push({ iter, variant: v.name, err: String(e && e.message).slice(0, 200) });
      log('routeErr', { iter, variant: v.name, m: String(e && e.message).slice(0, 300) });
    }
    await sleep(800);
  }
  await eda.pcb_Document.save();
  await sleep(1000);

  // 检查是否还有 Connection Error；没有就停
  // 注意：check(true,false,true) 返回**分组树** —— 顶层是类别节点
  // （{name:'Connection Error', count:2, list:[...]}），真正断点在 list 深层，
  // 且只有深层节点才有 errorType。只匹配 errorType 会把 2 个断点算成 0，
  // 让循环误以为已布通而提前 break（d6/d7/d11/d12 全部栽在这）。
  // 初值必须是 Infinity 而不是 0：DRC 若抛异常，原实现停在 0 →
  // 下一行 `if (stillUnconnected === 0) break` 把「查不出来」当成「已布通」，
  // 直接跳过重建覆铜和后续所有轮次，断连一路拖到最终 DRC。
  // 「未知」必须比「确定有断连」更保守。
  let stillUnconnected = Infinity;
  try {
    const d = await eda.pcb_Drc.check(true, false, true);
    const leaves = [];
    const walk = (n) => {
      if (!n) return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n.errorType === 'Connection Error') leaves.push(n);
      if (n.list) walk(n.list);
    };
    walk(d);
    // 深层叶子才是真断点数；若树里只有类别层也可以退化用 count
    if (leaves.length) stillUnconnected = leaves.length;
    else {
      const sumCount = (n) => {
        if (!n) return 0;
        if (Array.isArray(n)) return n.reduce((s, x) => s + sumCount(x), 0);
        if (n.list) return sumCount(n.list);
        return Number(n.count) || 0;
      };
      stillUnconnected = sumCount(d);
    }
  } catch (e) {
    log('iterDrcErr', String(e && e.message).slice(0, 120));
    errors.push('iterDrc: ' + String(e && e.message).slice(0, 120));
    // 查不出断点数 → 视为仍有断连，继续下一轮（不要 break）
  }
  log('routeIter', { iter, stillUnconnected });
  if (stillUnconnected === 0) break;
  // 还有断连 → 重建覆铜（新铜可能遮挡）后再来一轮
  try { await eda.pcb_PrimitivePour.rebuildAllCopperRegions(); } catch (e) { }
  await sleep(800);
}
log('routeAttempts', routeAttempts);
// 最后重建一次覆铜，确保铜皮反映最终走线
try {
  if (pourCount > 0) await eda.pcb_PrimitivePour.rebuildAllCopperRegions();
} catch (e) { }
await eda.pcb_Document.save();
await sleep(1500);

// ---------- 8.2 走线端点吸附 ----------
// 极速引擎输出的端点有浮点误差（例：363.101 vs 焊盘 363.3），导致 DRC 判为"未连接"。
// 把每条走线端点吸附到最近的同网焊盘/过孔中心，误差阈值 1.5mil。
phase('snapEnds');
let snapCount = 0;
try {
  const anchors = [];
  for (const id of (await eda.pcb_PrimitivePad.getAllPrimitiveId())) {
    const p = await eda.pcb_PrimitivePad.get(id);
    const net = p?.getState_Net?.();
    if (net) anchors.push({ net: String(net).toUpperCase(), x: p.getState_X(), y: p.getState_Y() });
  }
  for (const id of (await eda.pcb_PrimitiveVia.getAllPrimitiveId())) {
    const v = await eda.pcb_PrimitiveVia.get(id);
    const net = v?.getState_Net?.();
    if (net) anchors.push({ net: String(net).toUpperCase(), x: v.getState_X(), y: v.getState_Y() });
  }
  const SNAP = 1.5;
  // 按网络分桶：原来每条线都 anchors.filter(a => a.net === net) 全表扫描，
  // 复杂度 O(线数 x 锚点数)。实测该阶段 d7(2400x1800) 111.6s、d6 199.0s，
  // 是整条流水线最贵的一段，且与布线质量无关 —— 纯 CPU 浪费.
  const byNet = new Map();
  for (const a of anchors) {
    if (!byNet.has(a.net)) byNet.set(a.net, []);
    byNet.get(a.net).push(a);
  }
  const lineIds = await eda.pcb_PrimitiveLine.getAllPrimitiveId();
  const seen = new Set();           // net|两端坐标 → 已吸附过的线，用于挡完全重合的重复线
  let snapDup = 0, snapBudgetOut = false;
  for (const id of lineIds) {
    // 预算闸门：给 fixClearance / DRC / 导出留 120s。外部 --timeout 先到就会把这段代码
    // 丢在 render 里继续跑（幽灵调用），下一个 invoke 必挂，所以宁可提前收手.
    if (left() < 120000) { snapBudgetOut = true; break; }
    try {
      const l = await eda.pcb_PrimitiveLine.get(id);
      const net = String(l?.getState_Net?.() || '').toUpperCase();
      if (!net) continue;
      const pool = byNet.get(net);
      if (!pool) continue;
      let sx = l.getState_StartX(), sy = l.getState_StartY();
      let ex = l.getState_EndX(), ey = l.getState_EndY();
      let changed = false;
      for (const a of pool) {
        if (Math.hypot(sx - a.x, sy - a.y) < SNAP && (sx !== a.x || sy !== a.y)) { sx = a.x; sy = a.y; changed = true; }
        if (Math.hypot(ex - a.x, ey - a.y) < SNAP && (ex !== a.x || ey !== a.y)) { ex = a.x; ey = a.y; changed = true; }
      }
      if (!changed) continue;
      // 吸附后两端完全重合的两条同网线 = 一块铜压另一块铜，是 Clearance Error 的直接来源
      // （实测 d8 的 "LED_A5 track 与 GND track 间距 0 mil" 即由此而来）。保留第一条.
      const key = net + '|' + [sx, sy, ex, ey].map(v => Math.round(v * 100)).join(',');
      if (seen.has(key)) { snapDup++; continue; }
      seen.add(key);
      // modify 是唯一能正确写回画布的接口；toAsync+done 会报"对象参数不正确"
      await eda.pcb_PrimitiveLine.modify(id, {
        startX: sx, startY: sy, endX: ex, endY: ey });
      snapCount++;
    } catch (e) { log('snapErr', String(e && e.message).slice(0, 100)); }
  }
  log('snappedLines', { snapped: snapCount, dupSkipped: snapDup, budgetOut: snapBudgetOut, leftMs: left() });
} catch (e) { log('snapFail', String(e && e.message).slice(0, 150)); }
await sleep(1200);
try {
  if (pourCount > 0) await eda.pcb_PrimitivePour.rebuildAllCopperRegions();
} catch (e) { }
await eda.pcb_Document.save();
await sleep(1200);

// ---------- 8.35 断线缺口补铜 ----------
// 实测 d6/d7/d11/d12 全部卡在同一种失败：DRC 只报 1 组 Connection Error，
// 但扩板 4 次（1.5x / 2.0x）都不通 —— 因为**缺口是几何上没铜**，板子大小无关。
//
// 真实案例（d11 GND / U1_19）：
//   焊盘 (2106.9,-624.7) → 走线到 (2106.9,-625.7)   ← 只走 1mil
//   另一段走线起点 (2130.5,-625.7)                  ← 中间 23.6mil 完全空白
//
// ## 算法必须是「跨孤岛」，不能只找最近锚点
// 第一版用过「找离断点最近的锚点」，失败：最近锚点只有 1mil 远（就是那条碎片
// 走线的另一端），于是每轮都在 1mil 的同一个口子上重复描线，6 轮补 12 条废线，
// DRC 仍然 false。真实缺口 23.6mil 并不是「离断点最近」的那个点。
// 正确做法：把同网同层铜按几何连通性聚成孤岛（并查集），只跨**不同孤岛**补线。
//
// ## 坐标换算
// DRC 返回的 position 是真实画布坐标的 **1/10**（实测 210.64 对应 2105.97），
// 不乘 10 会在错误位置找锚点，必然找不到。
phase('stitchGaps');
let stitchCount = 0;
const MERGE = 2;        // 同层 ≤2mil 视为已连通
const MAX_GAP = 150;    // 跨岛补线上限；更远属布局级问题，硬补会横穿板子
const STITCH_W = 12;
try {
  // 收集全部锚点：焊盘中心 / 过孔（两层都算）/ 走线两端与中点
  const anchorsByNet = new Map();
  const addAnchor = (net, x, y, layer, id) => {
    const k = String(net || '').toUpperCase();
    if (!k || !Number.isFinite(x) || !Number.isFinite(y)) return;
    if (!anchorsByNet.has(k)) anchorsByNet.set(k, []);
    anchorsByNet.get(k).push({ x, y, layer, id });
  };
  for (const id of (await eda.pcb_PrimitivePad.getAllPrimitiveId()) || []) {
    try {
      const p = await eda.pcb_PrimitivePad.get(id);
      const n = p?.getState_Net?.();
      if (n) addAnchor(n, Number(p.getState_X()), Number(p.getState_Y()),
        p.getState_Layer?.() ?? 1, id);
    } catch (e) { }
  }
  for (const id of (await eda.pcb_PrimitiveVia.getAllPrimitiveId()) || []) {
    try {
      const v = await eda.pcb_PrimitiveVia.get(id);
      const n = v?.getState_Net?.();
      if (n) {
        const x = Number(v.getState_X()), y = Number(v.getState_Y());
        addAnchor(n, x, y, 1, id); addAnchor(n, x, y, 2, id);
      }
    } catch (e) { }
  }
  for (const id of (await eda.pcb_PrimitiveLine.getAllPrimitiveId()) || []) {
    try {
      const l = await eda.pcb_PrimitiveLine.get(id);
      const n = l?.getState_Net?.();
      if (!n) continue;
      const layer = l.getState_Layer?.() ?? 1;
      const sx = Number(l.getState_StartX()), sy = Number(l.getState_StartY());
      const ex = Number(l.getState_EndX()), ey = Number(l.getState_EndY());
      addAnchor(n, sx, sy, layer, id); addAnchor(n, ex, ey, layer, id);
      // 中点也要登记，否则长线中段附近的断点找不到所属孤岛
      addAnchor(n, (sx + ex) / 2, (sy + ey) / 2, layer, id);
    } catch (e) { }
  }

  // 并查集把同网同层的锚点聚成孤岛
  const buildIslands = (pool) => {
    const parent = pool.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const uni = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        if (Math.hypot(pool[i].x - pool[j].x, pool[i].y - pool[j].y) <= MERGE) uni(i, j);
      }
    }
    const g = new Map();
    for (let i = 0; i < pool.length; i++) {
      const r = find(i);
      if (!g.has(r)) g.set(r, []);
      g.get(r).push(i);
    }
    return [...g.values()];
  };
  log('stitchAnchors', { nets: anchorsByNet.size,
    total: [...anchorsByNet.values()].reduce((s, a) => s + a.length, 0) });

  for (let round = 0; round < 6; round++) {
    let details = null;
    try { details = await eda.pcb_Drc.check(true, false, true); } catch (e) { break; }
    const broken = [];
    const walk = (n) => {
      if (!n) return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n.errorType === 'Connection Error') broken.push(n);
      if (n.list) walk(n.list);
    };
    walk(details);
    if (!broken.length) { log('stitchDone', { round, remaining: 0 }); break; }

    let fixed = 0;
    for (const v of broken) {
      if (fixed >= 6) break;
      const ed = v.explanation?.errData || {};
      // DRC 坐标 = 真实坐标 / 10
      const px = Number(ed.position?.x) * 10, py = Number(ed.position?.y) * 10;
      const net = String(v.net || ed.net || '').toUpperCase();
      const layers = Array.isArray(ed.layerIds) && ed.layerIds.length ? ed.layerIds : [1];
      if (!net || !Number.isFinite(px) || !Number.isFinite(py)) continue;
      const all = anchorsByNet.get(net) || [];

      for (const layer of layers) {
        const pool = all.filter(a => a.layer === layer);
        if (pool.length < 2) continue;
        const islands = buildIslands(pool);
        if (islands.length < 2) continue;

        // 断点落在哪个孤岛（取岛内最近锚点）
        let myIsland = -1, myD = Infinity, myAnchor = null;
        islands.forEach((idx, gi) => {
          for (const i of idx) {
            const d = Math.hypot(pool[i].x - px, pool[i].y - py);
            if (d < myD) { myD = d; myIsland = gi; myAnchor = pool[i]; }
          }
        });
        if (myIsland < 0 || myD > 12) continue;

        // 从别的孤岛里找离 myAnchor 最近的点
        let other = null, otherD = Infinity;
        islands.forEach((idx, gi) => {
          if (gi === myIsland) return;
          for (const i of idx) {
            const d = Math.hypot(pool[i].x - myAnchor.x, pool[i].y - myAnchor.y);
            if (d < otherD) { otherD = d; other = pool[i]; }
          }
        });
        if (!other || otherD > MAX_GAP) continue;

        try {
          await eda.pcb_PrimitiveLine.create(net, layer,
            myAnchor.x, myAnchor.y, other.x, other.y, STITCH_W);
          stitchCount++; fixed++;
          log('stitch', { net, layer, gap: Math.round(otherD), islands: islands.length,
            from: [Math.round(myAnchor.x), Math.round(myAnchor.y)],
            to: [Math.round(other.x), Math.round(other.y)] });
        } catch (e) { log('stitchErr', String(e && e.message).slice(0, 120)); }
        break;   // 每个断点只补一层
      }
    }
    log('stitchRound', { round, broken: broken.length, fixed });
    if (!fixed) break;
    try { await eda.pcb_PrimitivePour.rebuildAllCopperRegions(); } catch (e) { }
    await sleep(700);
  }
  log('stitchedTotal', stitchCount);
} catch (e) { errors.push('stitchGaps: ' + (e && e.message)); }
await sleep(1000);
try { if (pourCount > 0) await eda.pcb_PrimitivePour.rebuildAllCopperRegions(); } catch (e) { }
await eda.pcb_Document.save();
await sleep(1200);

// DRC 报 Clearance Error 时：把冲突的过孔缩小到最小合法尺寸，仍冲突则删掉（覆铜已保证同网连通）
phase('fixClearance');
let clearanceFixes = 0;
for (let round = 0; round < 3; round++) {
  if (left() < 90000) { log('clearanceBudgetSkip', { round, leftMs: left() }); break; }
  let details = null;
  try { details = await eda.pcb_Drc.check(true, false, true); } catch (e) { break; }
  const flat = [];
  const walk = (n) => {
    if (!n) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.errorType) flat.push(n);
    if (n.list) walk(n.list);
  };
  walk(details);
  const clears = flat.filter(v => v.errorType === 'Clearance Error');
  if (!clears.length) { log('clearanceDone', { round, remaining: 0 }); break; }

  let fixed = 0;
  const seenVia = new Set();
  for (const v of clears) {
    const viaId = (v.objs || []).find(o => /^[0-9a-f]{18,20}$/.test(o) && o !== v.explanation?.errData?.obj1);
    // 直接找出这次违规里"Via"那侧的对象 id
    const ed = v.explanation?.errData || {};
    const viaObjId = ed.obj2Type === 'Via' ? ed.obj2 : (ed.obj1Type === 'Via' ? ed.obj1 : null);
    if (!viaObjId || seenVia.has(viaObjId)) continue;
    seenVia.add(viaObjId);
    try {
      const vv = await eda.pcb_PrimitiveVia.get(viaObjId);
      if (!vv) continue;
      const curD = Number(vv.getState_Diameter?.() || 0);
      const curH = Number(vv.getState_HoleDiameter?.() || 0);
      if (curD > 20.5) {
        // 先尝试缩到规则最小（0.5mm=19.7mil，孔 0.3mm=11.8mil）
        await eda.pcb_PrimitiveVia.modify(viaObjId, { holeDiameter: 11.8, diameter: 19.7 });
        fixed++;
        log('viaShrunk', { via: viaObjId, from: [curH, curD], to: [11.8, 19.7] });
      } else {
        // 删 via 前必须确认它不是"唯一通路"。注释说"GND 覆铜已保证连通"，
        // 但 via 也可能属于信号网 —— 实测 d11 的 XTAL_IN via 被删后整网断开，
        // DRC 报 Connection Error: XTAL_IN，4 种板框尺寸全部失败（假性 DRC 死循环）。
        // 只有 GND/覆铜网才允许删；信号网保留 via（宁可留 1 个间距违规，
        // 也不要断网 —— 断网是致命的，间距违规可人工微调）。
        let netName = '';
        try {
          netName = String(vv.getState_Net?.() || vv.getState_NetName?.() || '');
        } catch (e) {
          log('viaNetErr', { via: viaObjId, m: String(e && e.message).slice(0, 100) });
        }
        // 坑：原条件是 `if (!isPourNet && netName.trim()) continue` ——
        // 读不到网名时 netName 为空串，`netName.trim()` 为 falsy，整个条件短路成 false，
        // 于是**照样删 via**。而这正是注释里说的「删信号网 via 断整网」。
        // 保守原则：网名未知 = 可能是信号网 → 保留。
        // 留 1 个间距违规可人工微调，断网是致命的。
        if (!netName.trim()) {
          log('viaKept', { via: viaObjId, reason: 'net unreadable, keep to avoid breaking connectivity' });
          continue;
        }
        const isPourNet = /^(GND|GNDD|AGND|DGND|VSS|GROUND)$/i.test(netName.trim());
        if (!isPourNet) {
          log('viaKept', { via: viaObjId, net: netName.trim(), reason: 'signal net, deleting would break connectivity' });
          continue;
        }
        await eda.pcb_PrimitiveVia.delete(viaObjId);
        fixed++;
        log('viaDeleted', { via: viaObjId, d: curD, net: netName.trim() || '(unknown)' });
      }
    } catch (e) { log('viaFixErr', { via: viaObjId, m: String(e && e.message).slice(0, 120) }); }
  }

  // ---- Track 侧：缩窄 → 仍不够则绕行 ----
  // 原实现只处理 Via，实测 d12 的违规是 Track↔SMD Pad（VBUS 走线贴住 USB-C
  // 屏蔽壳 GND 多边形焊盘 e6e35），缩窄到最小 6.5mil 后仍差 1.4mil。
  //
  // 实测数据（d12 err24/err25）：
  //   焊盘多边形 bbox x[325.98,349.60] y[-347.43,-296.24]
  //   t144 中心线到焊盘边缘 0.07mil（-3.18 边缘距，等于压在焊盘上）
  //   t146 中心线 7.84mil（4.59 边缘距，要求 6）
  // 修法必须**绕行**而不是继续缩窄：把斜穿焊盘的线段改造成 L 形，
  // 从焊盘左侧安全走廊绕过去（实测 2 处违规 → 0，DRC 通过）。
    for (const v of clears) {
    const ed = v.explanation?.errData || {};
    const trackId = ed.obj1Type === 'Track' ? ed.obj1
                  : (ed.obj2Type === 'Track' ? ed.obj2 : null);
    if (!trackId || seenVia.has(trackId)) continue;
    seenVia.add(trackId);
    try {
      const tl = await eda.pcb_PrimitiveLine.get(trackId);
      if (!tl) continue;
      const curW = Number(tl.getState_LineWidth?.() ?? tl.getState_Width?.() ?? 0);

      // 第一步：先缩窄（无损 —— 铜还在，只是细一点，必然让间距变大）
      if (curW > 6.5) {
        await eda.pcb_PrimitiveLine.modify(trackId, { lineWidth: 6.5 });
        fixed++;
        log('trackThinned', { line: trackId, from: curW, to: 6.5,
          net: String(tl.getState_Net?.() || '') });
        continue;
      }

      // 第二步：已到最小线宽仍违规 → 绕行。需要异网障碍物的包围盒。
      // getState_Pad() 有多形态，必须分别解析 —— 早期实现只处理 POLYGON，
      // 导致 RECT 焊盘（如 d11 晶振 Y1_4 = ["RECT",55.1,47.2,0]）走
      // `verts.length < 3` 被静默跳过，绕行永不生效。
      //   RECT       → ['RECT', w, h, rot]      w/h 是**未旋转**尺寸
      //   POLYGON    → ['POLYGON', [x,y,'L',x,y,...]]
      //   OVAL/ROUND → 同 RECT，按外接矩形处理
      const padId = ed.obj1Type === 'SMD Pad' ? ed.obj1
                  : (ed.obj2Type === 'SMD Pad' ? ed.obj2 : null);
      if (!padId) continue;
      const pad = await eda.pcb_PrimitivePad.get(padId);
      if (!pad) continue;
      const raw = pad.getState_Pad?.();
      if (!Array.isArray(raw)) continue;
      const padKind = String(raw[0] || '').toUpperCase();
      const padX = Number(pad.getState_X?.() ?? NaN);
      const padY = Number(pad.getState_Y?.() ?? NaN);
      const padRot = Number(pad.getState_Rotation?.() || 0);
      let bx0, bx1, by0, by1;
      if (padKind === 'POLYGON' || padKind === 'POLY') {
        const vidx = raw[1];
        if (!Array.isArray(vidx)) continue;
        const vx = [], vy = [];
        for (let i = 0; i < vidx.length - 1; i++) {
          if (typeof vidx[i] === 'number' && typeof vidx[i + 1] === 'number') {
            vx.push(vidx[i]); vy.push(vidx[i + 1]);
          }
        }
        if (vx.length < 3) continue;
        bx0 = Math.min(...vx); bx1 = Math.max(...vx);
        by0 = Math.min(...vy); by1 = Math.max(...vy);
      } else if (padKind === 'RECT' || padKind === 'OVAL' || padKind === 'ROUND') {
        const pw = Number(raw[1]), ph = Number(raw[2]);
        if (!Number.isFinite(pw) || !Number.isFinite(ph)
            || !Number.isFinite(padX) || !Number.isFinite(padY)) continue;
        // 旋转后外接矩形：|w·cos|+|h·sin|  ×  |w·sin|+|h·cos|
        const rad = (padRot * Math.PI) / 180;
        const ac = Math.abs(Math.cos(rad)), as = Math.abs(Math.sin(rad));
        const bw = pw * ac + ph * as;
        const bh = pw * as + ph * ac;
        bx0 = padX - bw / 2; bx1 = padX + bw / 2;
        by0 = padY - bh / 2; by1 = padY + bh / 2;
      } else {
        continue;   // 未知形状，不冒险
      }

      const HALF = 3.25;              // 线宽一半
      const NEED = 6 + HALF + 1.0;    // 6mil 净距 + 半线宽 + 余量
      const sx = Number(tl.getState_StartX()), sy = Number(tl.getState_StartY());
      const ex = Number(tl.getState_EndX()), ey = Number(tl.getState_EndY());
      const net = String(tl.getState_Net?.() || '');
      const layer = tl.getState_Layer?.() ?? 1;

      // 走廊：焊盘四侧各一条，取第一条真正安全的（外侧留够净距）
      const corridors = [
        { axis: 'x', at: bx0 - NEED },   // 左
        { axis: 'x', at: bx1 + NEED },   // 右
        { axis: 'y', at: by0 - NEED },   // 下
        { axis: 'y', at: by1 + NEED },   // 上
      ];
      let chosen = null;
      for (const c of corridors) {
        if (!Number.isFinite(c.at)) continue;
        // 走廊必须真的在焊盘外侧（防止退化尺寸算出「走廊」压在焊盘上）
        const outside = c.axis === 'x'
          ? (c.at <= bx0 - 6 || c.at >= bx1 + 6)
          : (c.at <= by0 - 6 || c.at >= by1 + 6);
        if (!outside) continue;
        // 走廊两端都要能接回原线段（不能跑到板外或远处）
        const dS = c.axis === 'x' ? Math.abs(c.at - sx) : Math.abs(c.at - sy);
        const dE = c.axis === 'x' ? Math.abs(c.at - ex) : Math.abs(c.at - ey);
        if (Math.max(dS, dE) > 400) continue;
        chosen = c;
        break;
      }
      if (!chosen) continue;

      // 原斜线改成「起点 → 走廊拐点」，再补两段回到原终点（L 形）
      const cornerX = chosen.axis === 'x' ? chosen.at : sx;
      const cornerY = chosen.axis === 'y' ? chosen.at : sy;
      await eda.pcb_PrimitiveLine.modify(trackId, { endX: cornerX, endY: cornerY });
      await eda.pcb_PrimitiveLine.create(net, layer, cornerX, cornerY, cornerX, ey, 6.5);
      await eda.pcb_PrimitiveLine.create(net, layer, cornerX, ey, ex, ey, 6.5);
      fixed++;
      log('trackRerouted', { line: trackId, net, corridor: chosen.axis,
        at: Math.round(chosen.at), padKind,
        padBBox: [Math.round(bx0), Math.round(by0), Math.round(bx1), Math.round(by1)] });
    } catch (e) { log('trackFixErr', { id: trackId, m: String(e && e.message).slice(0, 120) }); }
  }
  clearanceFixes += fixed;
  log('clearanceRound', { round, violations: clears.length, fixed });
  if (!fixed) break;
  try { if (pourCount > 0) await eda.pcb_PrimitivePour.rebuildAllCopperRegions(); } catch (e) { }
  await eda.pcb_Document.save();
  await sleep(1200);
}
log('clearanceFixes', clearanceFixes);

// ---------- 8.5 兜底补线（仅在无铺铜时才用）----------
// 有 GND 铺铜时，铺铜本身会连接所有同网焊盘，手工补线只会制造间距违规 → 跳过
phase('patchDrc');
let patchCount = 0;
if (pourCount > 0) {
  log('patchSkipped', { reason: 'copper pour already connects same-net pads', pours: pourCount });
} else {
for (let round = 0; round < 3; round++) {
  if (left() < 60000) { log('patchBudgetSkip', { round, leftMs: left() }); break; }
  let details = null;
  try { details = await eda.pcb_Drc.check(true, false, true); } catch (e) { break; }
  const flat = [];
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.errorType) flat.push(node);
    if (node.list) walk(node.list);
  };
  walk(details);
  if (!flat.length) { log('patchDone', { round, remaining: 0 }); break; }

  // 收集板上的焊盘与过孔（含 net 与坐标）
  const nodes = [];
  try {
    for (const id of (await eda.pcb_PrimitivePad.getAllPrimitiveId())) {
      const p = await eda.pcb_PrimitivePad.get(id);
      if (p?.getState_Net?.()) nodes.push({ kind: 'pad', net: p.getState_Net(), x: p.getState_X(), y: p.getState_Y(), layer: p.getState_Layer?.() });
    }
    for (const id of (await eda.pcb_PrimitiveVia.getAllPrimitiveId())) {
      const v = await eda.pcb_PrimitiveVia.get(id);
      if (v?.getState_Net?.()) nodes.push({ kind: 'via', net: v.getState_Net(), x: v.getState_X(), y: v.getState_Y(), layer: 1 });
    }
  } catch (e) { }

  // 对每个断连对象：找同网最近的可达节点，用底层走线绕开顶层焊盘（最稳）
  let fixed = 0;
  for (const v of flat) {
    if (v.errorType !== 'Connection Error') continue;
    const net = v.net;
    const pos = v.pos || v.explanation?.errData?.position;
    if (!net || !pos) continue;
    const sameNet = nodes.filter(n => String(n.net).toUpperCase() === String(net).toUpperCase());
    if (sameNet.length < 2) continue;
    const sorted = sameNet.map(n => ({ ...n, d: Math.hypot(n.x - pos.x, n.y - pos.y) }))
      .sort((a, b) => a.d - b.d);
    const a = sorted[0], b = sorted[1];
    if (!a || !b || a.d < 0.5) continue;
    try {
      // 策略：从两点各打一个过孔到内层/底层，在底层直连，避开顶层所有焊盘
      const VL = 2;  // 底层
      await eda.pcb_PrimitiveVia.create(net, a.x, a.y, 12, 24);
      await eda.pcb_PrimitiveVia.create(net, b.x, b.y, 12, 24);
      if (Math.abs(a.y - b.y) < 0.01 || Math.abs(a.x - b.x) < 0.01) {
        await eda.pcb_PrimitiveLine.create(net, VL, a.x, a.y, b.x, b.y, 10, false);
      } else {
        await eda.pcb_PrimitiveLine.create(net, VL, a.x, a.y, b.x, a.y, 10, false);
        await eda.pcb_PrimitiveLine.create(net, VL, b.x, a.y, b.x, b.y, 10, false);
      }
      fixed++;
    } catch (e) { log('patchErr', { net, m: String(e && e.message).slice(0, 100) }); }
  }
  patchCount += fixed;
  log('patchRound', { round, violations: flat.length, fixed });
  await sleep(800);
  if (!fixed) break;
}
log('patchTotal', patchCount);
}   // end of `if (pourCount === 0)` patch block

// ---------- 9. DRC（显式执行 + 详细违规）----------
// 关键：判定前必须**重建覆铜并等它落定**，否则是在中间态上判 DRC。
// 实测 d6/d7 流水线报 FAIL（还因此白扩了 4 次板框），但工程存盘后
// 在流水线外独立复核是 passed=true、0 违规 —— 误判来自「覆铜还没重建完就检查」。
// 覆铜重建是异步的，rebuild 返回后仍需给渲染层时间，故这里重试到稳定为止。
await cam('pcb');   // DRC 后全板视图
phase('drc');
let drc = null, drcDetails = null, drcPassed = null;
try {
  // 最多 4 次：重建覆铜 → 等待 → 检查，取最后一次稳定结果
  for (let attempt = 0; attempt < 4; attempt++) {
    // 复跑一次 DRC 约 3~8s，跑满 4 次会把收尾拖过外部 timeout → 幽灵调用
    if (attempt > 0 && left() < 60000) { log('drcBudgetSkip', { attempt, leftMs: left() }); break; }
    try { await eda.pcb_PrimitivePour.rebuildAllCopperRegions(); } catch (e) { }
    await sleep(attempt === 0 ? 2500 : 1500);
    const p = await eda.pcb_Drc.check(true, false, false);
    drcPassed = p;
    log('drcAttempt', { attempt, passed: p });
    if (p === true) break;
  }
  await eda.pcb_Document.save();
  await sleep(1200);
  // 存盘后再确认一次：以落盘状态为准，避免内存态假阴性
  const persisted = await eda.pcb_Drc.check(true, false, false);
  if (persisted === true && drcPassed !== true) {
    log('drcPersistedOverride', { was: drcPassed, now: persisted });
  }
  if (persisted === true) drcPassed = true;
  drcDetails = await eda.pcb_Drc.check(true, false, true);
  log('drcCheck', { passed: drcPassed, detailLen: Array.isArray(drcDetails) ? drcDetails.length : null });
  try { drc = await eda.pcb_Drc.getDrcResult(); } catch (e) { }
  log('drcResult', drc ? { state: drc.state, n: drc.totalCount } : null);
} catch (e) { errors.push('drc: ' + (e && e.message)); }

// ---------- 10. 导出 ----------
await cam('pcb');   // 导出前回到全板视图
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
// 导出实测 20~51s（6 个文件），是收尾最后一段。预算不够时明确记 skipped，
// 让 ok:false 说得清原因，而不是拖过内部预算后被外部 timeout 变成幽灵调用.
const EXPORT_PLAN = [
  ['Gerber.zip', () => eda.pcb_ManufactureData.getGerberFile('AI_Board')],
  ['BOM.xlsx', () => eda.pcb_ManufactureData.getBomFile()],
  ['PnP.csv', () => eda.pcb_ManufactureData.getPickAndPlaceFile('AI_Board', 'csv', 'mm')],
  ['Netlist.json', () => eda.pcb_Net.getNetlist()],
  ['TestPoints.csv', () => eda.pcb_ManufactureData.getTestPointFile('AI_Board')],
  ['Board.pdf', () => eda.pcb_ManufactureData.getPdfFile('AI_Board')],
];
for (const [nm, getter] of EXPORT_PLAN) {
  if (left() < 45000) {
    exports.push({ name: nm, ok: false, skipped: 'budget', leftMs: left() });
    log('exportSkipped', { name: nm, leftMs: left() });
    continue;
  }
  exports.push(await ex(nm, getter));
}
log('exports', exports);

// 把本次**实际生效**的板框等信息落盘到产物目录，作为独立校验的唯一可信来源。
// 自愈会放大板框，设计文件里的原值已不代表本次实际使用值。
try {
  const meta = JSON.stringify({
    boardWidthMil: bw0, boardHeightMil: bh0,
    designName: D.name || null, idea: D._idea || null,
    components: (D.components || []).length, connections: (D.connections || []).length,
    ok: errors.length === 0, elapsedMs: Date.now() - T0,
    projectUuid, generatedAt: new Date().toISOString(),
  }, null, 1);
  await fs.saveFileToFileSystem(OUT + '\\_run.json', toBlob(meta), '_run.json');
} catch (e) {
  // 不能吞：_run.json 是独立校验器唯一可信的板框来源。写失败后校验器会退回
  // 设计文件里的**原始**板框，而自愈放大的实际板框丢失 → 判定比错对象。
  errors.push('_run.json: ' + String(e && e.message).slice(0, 120));
  log('runMetaFail', String(e && e.message).slice(0, 120));
}

log('budgetEnd', { totalMs: BUDGET, leftMs: left(), elapsedMs: Date.now() - T0 });

return {
  budgetMs: BUDGET, budgetLeftMs: left(),
  // 坑：原表达式不含导出/布局状态。实测 6 个导出全部 ok:false（相对 outDir 导致）
  // 时 errors 不增长 → 仍报 ok:true + artifacts:[]，产物目录空却判"通过"。
  // 导出是交付物本体，必须进 ok。
  ok: errors.length === 0 && mismatches.length === 0 && !!outlineOk
      && routeState === 'completed' && drcPassed === true && schDrcErrors === 0
      && layoutState === 'completed' && imported === true
      && exports.length === 6 && exports.every(e => e && e.ok === true)
      && artifacts.length >= 6,
  boardWidthMil: bw0, boardHeightMil: bh0,
  outlineFillRatio,
  projectUuid, boardName: board.name, schName, pageName, pageUuid, schUuid, pcbUuid,
  components: placed.map(p => ({ des: p.des, lcsc: p.lcsc, value: p.props?.Value })),
  netSummary, mismatchCount: mismatches.length, mismatches,
  schDrc,
  schDrcErrors, schDrcWarns,
  schDrcRules: [...new Set((schDrcViolations || []).map(v => v?.rule))],
  imported, outlineOk, layoutState, routeState,
  drcPassed,
  drcDetailCount: Array.isArray(drcDetails) ? drcDetails.length : null,
  drcDetails: Array.isArray(drcDetails) ? drcDetails.slice(0, 40) : drcDetails,
  drc: drc ? { state: drc.state, totalCount: drc.totalCount } : null,
  exports, artifacts, errors, warns, elapsedMs: Date.now() - T0, log: L,
};


