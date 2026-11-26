// d11b-02-map.js — 器件/焊盘（含旋转）地图 + DRC 明细（只读）
// args: { uuid, region?: {x0,x1,y0,y1}, des?: ["Y1","U1"] }
const A = __CLI__.args;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const R2 = v => (Number.isFinite(+v) ? +Number(v).toFixed(2) : v);
const S = (v, n) => String(v == null ? '' : v).slice(0, n || 60);

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
const walk = (n) => {
  if (!n) return;
  if (Array.isArray(n)) { n.forEach(walk); return; }
  if (n.errorType) {
    const ed = n.explanation?.errData || {};
    leaves.push({ kind: n.errorType, objType: n.errorObjType, rule: n.ruleName,
      o1: S(ed.obj1, 40), o1t: ed.obj1Type, o1s: S(ed.obj1Suffix, 50),
      o2: S(ed.obj2, 40), o2t: ed.obj2Type, o2s: S(ed.obj2Suffix, 50),
      net: S(ed.net || n.net, 24), layerIds: ed.layerIds || null,
      minDist: ed.minDistance, shouldBe: n.explanation?.param?.shouldBe,
      pos: ed.position ? [R2(ed.position.x * 10), R2(ed.position.y * 10)] : null });
    return;
  }
  if (n.list) walk(n.list);
};
walk(tree, []);

const rotBox = (x, y, w, h, rot) => {
  const rad = (Number(rot) || 0) * Math.PI / 180;
  const ac = Math.abs(Math.cos(rad)), as = Math.abs(Math.sin(rad));
  const bw = w * ac + h * as, bh = w * as + h * ac;
  return { x0: R2(x - bw / 2), x1: R2(x + bw / 2), y0: R2(y - bh / 2), y1: R2(y + bh / 2) };
};
const padBox = (p) => {
  const x = Number(p.getState_X()), y = Number(p.getState_Y()), rot = p.getState_Rotation?.();
  const raw = p.getState_Pad?.();
  if (!Array.isArray(raw)) return null;
  const t = String(raw[0] || '').toUpperCase();
  if (t === 'POLYGON' && Array.isArray(raw[1])) {
    const a = raw[1], xs = [], ys = [];
    for (let i = 0; i + 1 < a.length; i += 2) if (typeof a[i] === 'number') { xs.push(a[i]); ys.push(a[i + 1]); }
    if (!xs.length) return null;
    return { t, x0: R2(x + Math.min(...xs)), x1: R2(x + Math.max(...xs)), y0: R2(y + Math.min(...ys)), y1: R2(y + Math.max(...ys)) };
  }
  if (typeof raw[1] === 'number' && typeof raw[2] === 'number') {
    return Object.assign({ t, w: raw[1], h: raw[2] }, rotBox(x, y, raw[1], raw[2], rot));
  }
  return { t, raw: raw.slice(0, 5) };
};

// 器件 → 焊盘
const want = (A.des || ['Y1', 'U1']).map(s => String(s).toUpperCase());
const comps = [];
for (const cid of (await eda.pcb_PrimitiveComponent.getAllPrimitiveId()) || []) {
  try {
    const c = await eda.pcb_PrimitiveComponent.get(cid);
    const des = String(c.getState_Designator?.() || '');
    if (!want.some(w => des.toUpperCase() === w)) continue;
    const pins = (await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(cid)) || [];
    const pads = [];
    for (const pid of pins) {
      try {
        const p = await eda.pcb_PrimitivePad.get(pid);
        pads.push({ id: pid, num: S(p.getState_Number?.(), 16), net: S(p.getState_Net?.(), 24),
          x: R2(p.getState_X()), y: R2(p.getState_Y()), rot: p.getState_Rotation?.(),
          layer: p.getState_Layer?.(), box: padBox(p) });
      } catch (e) { }
    }
    comps.push({ id: cid, des, x: R2(c.getState_X?.()), y: R2(c.getState_Y?.()), rot: c.getState_Rotation?.(), pads });
  } catch (e) { }
}

const region = A.region || null;
const inR = (x, y) => !region || (x >= region.x0 && x <= region.x1 && y >= region.y0 && y <= region.y1);
const lines = [];
for (const id of (await eda.pcb_PrimitiveLine.getAllPrimitiveId()) || []) {
  try {
    const l = await eda.pcb_PrimitiveLine.get(id);
    const x1 = Number(l.getState_StartX()), y1 = Number(l.getState_StartY());
    const x2 = Number(l.getState_EndX()), y2 = Number(l.getState_EndY());
    if (!inR(x1, y1) && !inR(x2, y2)) continue;
    lines.push({ id, net: S(l.getState_Net?.(), 24), L: l.getState_Layer?.(),
      x1: R2(x1), y1: R2(y1), x2: R2(x2), y2: R2(y2), w: R2(l.getState_LineWidth?.()) });
  } catch (e) { }
}
const vias = [];
for (const id of (await eda.pcb_PrimitiveVia.getAllPrimitiveId()) || []) {
  try {
    const v = await eda.pcb_PrimitiveVia.get(id);
    const x = Number(v.getState_X()), y = Number(v.getState_Y());
    if (!inR(x, y)) continue;
    vias.push({ id, net: S(v.getState_Net?.(), 24), x: R2(x), y: R2(y),
      d: R2(v.getState_Diameter?.()), hole: R2(v.getState_HoleDiameter?.()) });
  } catch (e) { }
}
return { pcbName: pcb.name, passed, leaves, comps, lines, vias };
