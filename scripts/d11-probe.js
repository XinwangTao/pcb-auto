// 探查 d11 脏工程的 XTAL_IN 几何与 DRC 明细
// 用法：invoke --code-file scripts/d11-probe.js --args '{"uuid":"42379b71..."}'
const A = __CLI__.args;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const S = (v, n) => String(v == null ? '' : v).slice(0, n || 120);

await eda.dmt_Project.openProject(A.uuid);
await sleep(2500);
const pcbs = await eda.dmt_Pcb.getAllPcbsInfo();
const pcb = (pcbs || [])[0];
if (!pcb) return { error: 'no pcb' };
await eda.dmt_EditorControl.openDocument(pcb.uuid);
await eda.dmt_EditorControl.waitForDocumentReady(pcb.uuid, 60000);
await sleep(1500);

try { await eda.pcb_PrimitivePour.rebuildAllCopperRegions(); } catch (e) { }
await sleep(2500);

const passed = await eda.pcb_Drc.check(true, false, false);
const tree = await eda.pcb_Drc.check(true, false, true);

// ---- 递归展开 DRC 树 ----
const leaves = [];
const walk = (n, path) => {
  if (!n) return;
  if (Array.isArray(n)) { n.forEach(x => walk(x, path)); return; }
  if (n.errorType) {
    const ed = n.explanation?.errData || {};
    leaves.push({
      errorType: n.errorType, errorObjType: n.errorObjType, rule: n.ruleName,
      obj1: S(n.obj1?.suffix, 80), obj2: S(n.obj2?.suffix, 80),
      net: S(n.net || ed.net, 40),
      minDistance: ed.minDistance ?? n.explanation?.param?.minDistance,
      shouldBe: n.explanation?.param?.shouldBe,
      pos: ed.position ? [ed.position.x, ed.position.y] : null,
      layerIds: ed.layerIds || null,
      o1: ed.obj1, o1t: ed.obj1Type, o1s: S(ed.obj1Suffix, 60),
      o2: ed.obj2, o2t: ed.obj2Type, o2s: S(ed.obj2Suffix, 60),
      path: path,
    });
    return;
  }
  if (n.list) walk(n.list, [...path, S(n.name || n.title, 40)]);
};

// 顶层节点结构（确认是否有 errorType）
const topShape = Array.isArray(tree) ? tree.map(n => ({ keys: Object.keys(n || {}), name: S(n?.name, 40), count: n?.count, hasList: Array.isArray(n?.list) })) : tree;
walk(tree, []);

// ---- 线 ----
const lines = [];
for (const id of (await eda.pcb_PrimitiveLine.getAllPrimitiveId()) || []) {
  try {
    const l = await eda.pcb_PrimitiveLine.get(id);
    lines.push({
      id, net: S(l.getState_Net?.(), 40), layer: l.getState_Layer?.(),
      x1: +Number(l.getState_StartX()).toFixed(2), y1: +Number(l.getState_StartY()).toFixed(2),
      x2: +Number(l.getState_EndX()).toFixed(2), y2: +Number(l.getState_EndY()).toFixed(2),
      w: Number(l.getState_LineWidth?.()),
    });
  } catch (e) { }
}

// ---- 焊盘 ----
const bboxOf = (raw) => {
  if (!Array.isArray(raw)) return null;
  const t = String(raw[0] || '').toUpperCase();
  if (t === 'RECT') { const w = raw[1], h = raw[2]; return { t, w, h, hw: w / 2, hh: h / 2 }; }
  if (t === 'CIRCLE' || t === 'OVAL') { const w = raw[1], h = raw[2]; return { t, w, h, hw: w / 2, hh: h / 2 }; }
  if (t === 'POLYGON' && Array.isArray(raw[1])) {
    const a = raw[1]; const xs = [], ys = [];
    for (let i = 0; i + 1 < a.length; i += 2) if (typeof a[i] === 'number') { xs.push(a[i]); ys.push(a[i + 1]); }
    if (!xs.length) return null;
    return { t, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), n: xs.length };
  }
  return { t, raw: raw.slice(0, 6) };
};
const pads = [];
for (const id of (await eda.pcb_PrimitivePad.getAllPrimitiveId()) || []) {
  try {
    const p = await eda.pcb_PrimitivePad.get(id);
    const raw = p.getState_Pad?.();
    const x = Number(p.getState_X()), y = Number(p.getState_Y());
    const bb = bboxOf(raw);
    pads.push({
      id, net: S(p.getState_Net?.(), 40), num: S(p.getState_Number?.(), 20),
      layer: p.getState_Layer?.(), rot: p.getState_Rotation?.(),
      x: +x.toFixed(2), y: +y.toFixed(2), shape: bb,
      abs: bb && bb.x0 !== undefined
        ? { x0: +(x + bb.x0).toFixed(2), x1: +(x + bb.x1).toFixed(2), y0: +(y + bb.y0).toFixed(2), y1: +(y + bb.y1).toFixed(2) }
        : (bb && bb.hw ? { x0: +(x - bb.hw).toFixed(2), x1: +(x + bb.hw).toFixed(2), y0: +(y - bb.hh).toFixed(2), y1: +(y + bb.hh).toFixed(2) } : null),
    });
  } catch (e) { }
}

// ---- 过孔 ----
const vias = [];
for (const id of (await eda.pcb_PrimitiveVia.getAllPrimitiveId()) || []) {
  try {
    const v = await eda.pcb_PrimitiveVia.get(id);
    vias.push({ id, net: S(v.getState_Net?.(), 40), x: +Number(v.getState_X()).toFixed(2), y: +Number(v.getState_Y()).toFixed(2),
      d: Number(v.getState_Diameter?.()), hole: Number(v.getState_HoleDiameter?.()) });
  } catch (e) { }
}

// ---- 覆铜 ----
const pours = [];
for (const id of (await eda.pcb_PrimitivePour.getAllPrimitiveId?.()) || []) {
  try {
    const p = await eda.pcb_PrimitivePour.get(id);
    pours.push({ id, net: S(p.getState_Net?.(), 40), layer: p.getState_Layer?.() });
  } catch (e) { }
}

const xtalLines = lines.filter(l => /XTAL_IN/i.test(l.net));
const xtalPads = pads.filter(p => /XTAL_IN/i.test(p.net));
const y1Pads = pads.filter(p => /^Y1/i.test(p.num) || p.num === 'Y1');

return {
  pcbName: pcb.name, passed, topShape, leafCount: leaves.length,
  leaves: leaves.slice(0, 20),
  counts: { lines: lines.length, pads: pads.length, vias: vias.length, pours: pours.length },
  pours,
  xtalLines, xtalPads, y1Pads,
  viasNear: vias.filter(v => v.x > 1250 && v.x < 1450 && v.y > -260 && v.y < -20),
  linesNear: lines.filter(l => Math.max(l.x1, l.x2) > 1290 && Math.min(l.x1, l.x2) < 1420
    && Math.max(l.y1, l.y2) > -230 && Math.min(l.y1, l.y2) < -30),
  pad20: pads.filter(p => /U1/.test(p.num) && /(^|[^0-9])20([^0-9]|$)/.test(p.num)),
};
