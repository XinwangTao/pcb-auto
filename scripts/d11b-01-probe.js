// d11b-01-probe.js — 探查工程几何与 DRC（只读）
// args: { uuid, region?: {x0,x1,y0,y1} }
const A = __CLI__.args;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const R2 = v => (Number.isFinite(+v) ? +Number(v).toFixed(2) : v);
const S = (v, n) => String(v == null ? '' : v).slice(0, n || 80);

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
const leaves = [];
const walk = (n, path) => {
  if (!n) return;
  if (Array.isArray(n)) { n.forEach(x => walk(x, path)); return; }
  if (n.errorType) {
    const ed = n.explanation?.errData || {};
    leaves.push({
      kind: n.errorType, objType: n.errorObjType, rule: n.ruleName,
      o1: S(ed.obj1, 40), o1t: ed.obj1Type, o1s: S(ed.obj1Suffix, 60),
      o2: S(ed.obj2, 40), o2t: ed.obj2Type, o2s: S(ed.obj2Suffix, 60),
      net: S(ed.net || n.net, 30),
      layerIds: ed.layerIds || null,
      minDist: ed.minDistance, shouldBe: n.explanation?.param?.shouldBe,
      // 注意：DRC 坐标是真实坐标的 1/10
      posX10: ed.position ? [R2(ed.position.x * 10), R2(ed.position.y * 10)] : null,
      path: path,
    });
    return;
  }
  if (n.list) walk(n.list, [...path, S(n.name || n.title, 30)]);
};
walk(tree, []);

const region = A.region || null;
const inRegion = (x, y) => !region || (x >= region.x0 && x <= region.x1 && y >= region.y0 && y <= region.y1);

const bbox = (raw) => {
  if (!Array.isArray(raw)) return null;
  const t = String(raw[0] || '').toUpperCase();
  if (t === 'POLYGON' && Array.isArray(raw[1])) {
    const a = raw[1], xs = [], ys = [];
    for (let i = 0; i + 1 < a.length; i += 2) if (typeof a[i] === 'number') { xs.push(a[i]); ys.push(a[i + 1]); }
    if (!xs.length) return null;
    return { t, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  }
  if (typeof raw[1] === 'number' && typeof raw[2] === 'number') {
    const w = raw[1], h = raw[2];
    return { t, w, h, hw: w / 2, hh: h / 2 };
  }
  return { t };
};

const pads = [];
for (const id of (await eda.pcb_PrimitivePad.getAllPrimitiveId()) || []) {
  try {
    const p = await eda.pcb_PrimitivePad.get(id);
    const x = Number(p.getState_X()), y = Number(p.getState_Y());
    if (!Number.isFinite(x) || !inRegion(x, y)) continue;
    const bb = bbox(p.getState_Pad?.());
    const rot = Number(p.getState_Rotation?.() || 0);
    let abs = null;
    if (bb && bb.x0 !== undefined) abs = { x0: R2(x + bb.x0), x1: R2(x + bb.x1), y0: R2(y + bb.y0), y1: R2(y + bb.y1) };
    else if (bb && bb.hw) {
      const rad = rot * Math.PI / 180, ac = Math.abs(Math.cos(rad)), as = Math.abs(Math.sin(rad));
      const bw = bb.w * ac + bb.h * as, bh = bb.w * as + bb.h * ac;
      abs = { x0: R2(x - bw / 2), x1: R2(x + bw / 2), y0: R2(y - bh / 2), y1: R2(y + bh / 2) };
    }
    pads.push({ id, num: S(p.getState_Number?.(), 20), net: S(p.getState_Net?.(), 30),
      layer: p.getState_Layer?.(), rot, x: R2(x), y: R2(y), shape: bb, abs });
  } catch (e) { }
}

const lines = [];
for (const id of (await eda.pcb_PrimitiveLine.getAllPrimitiveId()) || []) {
  try {
    const l = await eda.pcb_PrimitiveLine.get(id);
    const x1 = Number(l.getState_StartX()), y1 = Number(l.getState_StartY());
    const x2 = Number(l.getState_EndX()), y2 = Number(l.getState_EndY());
    if (!inRegion(x1, y1) && !inRegion(x2, y2)) continue;
    lines.push({ id, net: S(l.getState_Net?.(), 30), layer: l.getState_Layer?.(),
      x1: R2(x1), y1: R2(y1), x2: R2(x2), y2: R2(y2), w: R2(l.getState_LineWidth?.()) });
  } catch (e) { }
}

const vias = [];
for (const id of (await eda.pcb_PrimitiveVia.getAllPrimitiveId()) || []) {
  try {
    const v = await eda.pcb_PrimitiveVia.get(id);
    const x = Number(v.getState_X()), y = Number(v.getState_Y());
    if (!inRegion(x, y)) continue;
    vias.push({ id, net: S(v.getState_Net?.(), 30), x: R2(x), y: R2(y),
      d: R2(v.getState_Diameter?.()), hole: R2(v.getState_HoleDiameter?.()) });
  } catch (e) { }
}

const pours = [];
try {
  for (const id of (await eda.pcb_PrimitivePour.getAllPrimitiveId?.()) || []) {
    const p = await eda.pcb_PrimitivePour.get(id);
    pours.push({ id, net: S(p.getState_Net?.(), 30), layer: p.getState_Layer?.() });
  }
} catch (e) { }

let stackup = null;
try { stackup = await eda.pcb_Layer.getStackup(); } catch (e) { }
let ruleCfgName = null;
try { ruleCfgName = await eda.pcb_Drc.getCurrentRuleConfigurationName(); } catch (e) { }

return {
  pcbName: pcb.name, passed, leafCount: leaves.length, leaves,
  counts: { pads: pads.length, lines: lines.length, vias: vias.length, pours: pours.length },
  pours, stackup, ruleCfgName,
  pads, lines, vias,
};
