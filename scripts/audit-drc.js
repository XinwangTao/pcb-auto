/* ============================================================
 * audit-drc.js — 独立只读复核（PCB DRC），**逐块 PCB** 版本
 *
 * 为什么必须逐块：pipeline3.js 旧版 createBoard() 是异步的，重试循环会真的
 * 建出 2~5 块板（实测 d6/d11 工程里躺着 PCB1 + PCB2）。用
 * getAllPcbsInfo()[0] 复核，可能查到的是一块空板，passed 毫无意义。
 * 所以本脚本对工程内**每一块 PCB 都跑一遍**，并明确标出
 * 「流水线真正在用的那块」（board.pcb.uuid，取第一块同时有原理图页和 PCB 的板，
 * 与 pipeline3.js 的取法一致）。
 *
 * 用法：
 *   & $cli invoke --session <sid> --ext-uuid eda --code-file scripts\audit-drc.js ^
 *       --args '{"uuid":"<projectUuid>"}' --timeout 600000
 *
 * 只读：全程不 save / modify / create / delete。rebuildAllCopperRegions()
 * 只改内存态（进程退出即丢弃），用来消掉「覆铜未重建完就判 DRC」的假阴性。
 *
 * 每个 PCB 跑两遍 DRC：
 *   before —— 刚打开文档、未重建覆铜
 *   after  —— rebuildAllCopperRegions() 之后
 * 两遍任一遍 true 即认为该板产物是好的；before≠after 就是假阴性的直接证据。
 * ============================================================ */
const args = (typeof __CLI__ !== 'undefined' && __CLI__.args) || {};
const uuid = String(args.uuid || '').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const L = [];
const log = (k, v) => { L.push(v === undefined ? k : { k, v }); };

if (!uuid) return { ok: false, err: 'no uuid arg' };
if (typeof eda === 'undefined') return { ok: false, err: 'no eda global', log: L };

function flatten(tree) {
  const flat = [];
  const walk = (n) => {
    if (!n) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.errorType) flat.push(n);
    if (n.list) walk(n.list);
  };
  walk(tree);
  return flat;
}
function num(...cands) {
  for (const c of cands) {
    if (c === null || c === undefined) continue;
    const v = Number(c);
    if (Number.isFinite(v)) return v;
  }
  return null;
}
function summarize(details) {
  const flat = flatten(details);
  const byType = {};
  const byNet = {};
  for (const f of flat) {
    byType[f.errorType] = (byType[f.errorType] || 0) + 1;
    const n = f.net || (f.explanation && f.explanation.errData && f.explanation.errData.net) || '(none)';
    byNet[n] = (byNet[n] || 0) + 1;
  }
  const samples = flat.slice(0, 12).map((x) => {
    const ed = (x.explanation && x.explanation.errData) || {};
    const pm = (x.explanation && x.explanation.param) || {};
    const pos = x.pos || ed.position || null;
    return {
      t: x.errorType,
      net: x.net ?? ed.net ?? null,
      o1: ed.obj1Suffix ?? ed.obj1 ?? null,
      o1t: ed.obj1Type ?? null,
      o2: ed.obj2Suffix ?? ed.obj2 ?? null,
      o2t: ed.obj2Type ?? null,
      pos: pos ? { x: Math.round(pos.x * 100) / 100, y: Math.round(pos.y * 100) / 100 } : null,
      minDistance: num(pm.minDistance, pm.min, pm.ruleDistance),
      actualDistance: num(pm.distance, pm.actualDistance, pm.realDistance),
      layer: ed.layer ?? null,
      obj1Id: ed.obj1 ?? null,
      obj2Id: ed.obj2 ?? null,
    };
  });
  return { total: flat.length, byType, byNet, samples };
}

const out = { ok: true, uuid, log: L };
try {
  // ---------- 1. 打开工程并等目录树就绪 ----------
  await eda.dmt_Project.openProject(uuid);
  log('openProject', true);
  await sleep(3000);
  try { await eda.dmt_Project.waitForReady(uuid, 60000); } catch (e) { log('waitForReadyErr', String(e && e.message).slice(0, 200)); }
  await sleep(1500);

  const boards = (await eda.dmt_Board.getAllBoardsInfo()) || [];
  const pcbs = (await eda.dmt_Pcb.getAllPcbsInfo()) || [];
  out.boardCount = boards.length;
  out.pcbCount = pcbs.length;
  out.boards = boards.map((b) => ({
    name: b.name,
    uuid: b.uuid,
    schematicUuid: b.schematic && b.schematic.uuid,
    pageCount: (b.schematic && b.schematic.page && b.schematic.page.length) || 0,
    pcbUuid: b.pcb && b.pcb.uuid,
    pcbName: b.pcb && b.pcb.name,
  }));
  out.pcbs = pcbs.map((p) => ({ name: p.name, uuid: p.uuid, boardName: p.parentBoardName }));
  // 与 pipeline3.js 完全一致的取法：第一块同时有原理图页和 PCB 的板
  const primary = boards.find((b) => b.schematic && b.schematic.page && b.schematic.page.length && b.pcb) || null;
  out.primaryPcbUuid = primary && primary.pcb ? primary.pcb.uuid : null;
  out.primaryBoardName = primary ? primary.name : null;

  // 复核顺序：先 primary，再其余
  const order = [];
  if (out.primaryPcbUuid) order.push(out.primaryPcbUuid);
  for (const p of pcbs) if (p.uuid !== out.primaryPcbUuid) order.push(p.uuid);

  out.perPcb = [];
  for (const pcbUuid of order) {
    const rec = { pcbUuid, isPrimary: pcbUuid === out.primaryPcbUuid };
    const nm = pcbs.find((p) => p.uuid === pcbUuid);
    rec.pcbName = nm ? nm.name : null;
    try {
      await eda.dmt_EditorControl.openDocument(pcbUuid);
      await eda.dmt_EditorControl.waitForDocumentReady(pcbUuid, 60000);
    } catch (e) { rec.openErr = String(e && e.message).slice(0, 200); }
    await sleep(2000);

    // 板框 / 焊盘跨度
    try {
      let x0 = null, y0 = null, w = null, h = null;
      const plIds = await eda.pcb_PrimitivePolyline.getAllPrimitiveId();
      for (const id of (plIds || [])) {
        const pl = await eda.pcb_PrimitivePolyline.get(id);
        if (pl?.getState_Layer?.() !== 11) continue;
        const src = pl?.getState_Polygon?.()?.getSource?.();
        if (Array.isArray(src) && src[0] === 'R') { x0 = src[1]; y0 = src[2]; w = src[3]; h = src[4]; break; }
      }
      rec.outline = { x: x0, y: y0, w: w, h: h };
      let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity, nPad = 0;
      const padIds = await eda.pcb_PrimitivePad.getAllPrimitiveId();
      for (const id of (padIds || [])) {
        const p = await eda.pcb_PrimitivePad.get(id);
        const px = p?.getState_X?.(), py = p?.getState_Y?.();
        if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
        nPad++;
        if (px < xMin) xMin = px; if (px > xMax) xMax = px;
        if (py < yMin) yMin = py; if (py > yMax) yMax = py;
      }
      rec.padCount = nPad;
      if (Number.isFinite(xMin)) {
        const spanW = xMax - xMin, spanH = yMax - yMin;
        rec.padSpan = { w: Math.round(spanW), h: Math.round(spanH) };
        if (Number.isFinite(w) && w > 0 && h > 0) rec.fillRatio = Math.round((spanW * spanH) / (w * h) * 1000) / 1000;
      }
      try {
        const vIds = await eda.pcb_PrimitiveVia.getAllPrimitiveId();
        rec.viaCount = (vIds || []).length;
      } catch (e) { }
      try {
        const tIds = await eda.pcb_PrimitiveLine.getAllPrimitiveId();
        rec.trackCount = (tIds || []).length;
      } catch (e) { }
    } catch (e) {
      // 文档没正确打开时这里会抛 "Cannot read properties of null (reading 'map')"
      rec.padErr = String(e && e.message).slice(0, 200);
      log('padErr', { pcbUuid, m: rec.padErr });
    }

    // DRC 第一遍：落盘态
    try {
      rec.passedBefore = await eda.pcb_Drc.check(true, false, false);
      rec.before = summarize(await eda.pcb_Drc.check(true, false, true));
    } catch (e) { rec.drc1Err = String(e && e.message).slice(0, 200); }

    // 重建覆铜（只改内存态）后再判
    try { await eda.pcb_PrimitivePour.rebuildAllCopperRegions(); rec.rebuilt = true; } catch (e) { rec.rebuildErr = String(e && e.message).slice(0, 200); }
    await sleep(2500);
    try {
      rec.passedAfter = await eda.pcb_Drc.check(true, false, false);
      rec.after = summarize(await eda.pcb_Drc.check(true, false, true));
    } catch (e) { rec.drc2Err = String(e && e.message).slice(0, 200); }

    rec.passed = (rec.passedBefore === true || rec.passedAfter === true);
    rec.stable = (rec.passedBefore === rec.passedAfter);
    out.perPcb.push(rec);
  }

  const prim = out.perPcb.find((r) => r.isPrimary) || out.perPcb[0] || null;
  out.passed = prim ? prim.passed : null;
  out.violations = prim && prim.after ? prim.after.total : null;
  out.violationsBefore = prim && prim.before ? prim.before.total : null;
  out.multiPcb = out.pcbCount > 1;
  out.saved = false;
} catch (e) {
  return { ok: false, err: String(e && e.message).slice(0, 400), uuid, log: L };
}
return out;
