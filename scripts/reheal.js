/**
 * 在指定工程上复跑 pipeline3 的修复逻辑（补铜 + 间距），验证真实效果。
 * 用法：node reheal.js <projectUuid> [sessionId]
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CLI = process.env.PCB_AUTO_LCEDA || process.env.LCEDA;
if (!CLI) {
  console.error('找不到 lceda-pro.exe。设置 PCB_AUTO_LCEDA 指向它（本项目只支持 4.1.111）。');
  process.exit(2);
}
const uuid = process.argv[2];
const session = process.argv[3];
if (!uuid) { console.error('用法: node reheal.js <projectUuid> [sessionId]'); process.exit(2); }

const body = `
const A = __CLI__.args;
await eda.dmt_Project.openProject(A.uuid);
await new Promise(r => setTimeout(r, 3000));
const pcbs = await eda.dmt_Pcb.getAllPcbsInfo();
if (!pcbs || !pcbs.length) return { err: 'no pcb' };
await eda.dmt_EditorControl.openDocument(pcbs[0].uuid);
await eda.dmt_EditorControl.waitForDocumentReady(pcbs[0].uuid, 60000);
await new Promise(r => setTimeout(r, 2000));

const summary = () => {
  const s = { passed: null, broken: 0, clearance: 0, other: 0, items: [] };
  return s;
};
async function scan() {
  const passed = await eda.pcb_Drc.check(true, false, false);
  const d = await eda.pcb_Drc.check(true, false, true);
  const flat = [];
  const walk = (n) => { if (!n) return; if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.errorType) flat.push(n); if (n.list) walk(n.list); };
  walk(d);
  return { passed, broken: flat.filter(x => x.errorType === 'Connection Error').length,
    clearance: flat.filter(x => x.errorType === 'Clearance Error').length,
    other: flat.filter(x => !/Connection|Clearance/.test(x.errorType)).length,
    flat };
}

const before = await scan();
const acts = [];

// ---- 补铜（孤岛跨越）----
const MERGE = 2, MAX_GAP = 150, STITCH_W = 6.5;
const anchorsByNet = new Map();
const add = (net, x, y, layer, id) => {
  const k = String(net || '').toUpperCase();
  if (!k || !Number.isFinite(x) || !Number.isFinite(y)) return;
  if (!anchorsByNet.has(k)) anchorsByNet.set(k, []);
  anchorsByNet.get(k).push({ x, y, layer, id });
};
for (const id of (await eda.pcb_PrimitivePad.getAllPrimitiveId()) || []) {
  try { const p = await eda.pcb_PrimitivePad.get(id); const n = p?.getState_Net?.();
    if (n) add(n, Number(p.getState_X()), Number(p.getState_Y()), p.getState_Layer?.() ?? 1, id);
  } catch (e) {}
}
for (const id of (await eda.pcb_PrimitiveVia.getAllPrimitiveId()) || []) {
  try { const v = await eda.pcb_PrimitiveVia.get(id); const n = v?.getState_Net?.();
    if (n) { const x = Number(v.getState_X()), y = Number(v.getState_Y());
      add(n, x, y, 1, id); add(n, x, y, 2, id); }
  } catch (e) {}
}
for (const id of (await eda.pcb_PrimitiveLine.getAllPrimitiveId()) || []) {
  try { const l = await eda.pcb_PrimitiveLine.get(id); const n = l?.getState_Net?.();
    if (!n) continue; const layer = l.getState_Layer?.() ?? 1;
    const sx = Number(l.getState_StartX()), sy = Number(l.getState_StartY());
    const ex = Number(l.getState_EndX()), ey = Number(l.getState_EndY());
    add(n, sx, sy, layer, id); add(n, ex, ey, layer, id);
    add(n, (sx+ex)/2, (sy+ey)/2, layer, id);
  } catch (e) {}
}
const buildIslands = (pool) => {
  const parent = pool.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const uni = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let i = 0; i < pool.length; i++)
    for (let j = i + 1; j < pool.length; j++)
      if (Math.hypot(pool[i].x - pool[j].x, pool[i].y - pool[j].y) <= MERGE) uni(i, j);
  const g = new Map();
  for (let i = 0; i < pool.length; i++) { const r = find(i); if (!g.has(r)) g.set(r, []); g.get(r).push(i); }
  return [...g.values()];
};

for (let round = 0; round < 6; round++) {
  const s = await scan();
  if (!s.broken) { acts.push({ round, stitchDone: true }); break; }
  let fixed = 0;
  for (const v of s.flat.filter(x => x.errorType === 'Connection Error')) {
    if (fixed >= 6) break;
    const ed = v.explanation?.errData || {};
    const px = Number(ed.position?.x) * 10, py = Number(ed.position?.y) * 10;
    const net = String(ed.net || v.net || '').toUpperCase();
    const layers = Array.isArray(ed.layerIds) && ed.layerIds.length ? ed.layerIds : [1];
    if (!net || !Number.isFinite(px) || !Number.isFinite(py)) continue;
    const all = anchorsByNet.get(net) || [];
    for (const layer of layers) {
      const pool = all.filter(a => a.layer === layer);
      if (pool.length < 2) continue;
      const islands = buildIslands(pool);
      if (islands.length < 2) continue;
      let myI = -1, myD = Infinity, myA = null;
      islands.forEach((idx, gi) => { for (const i of idx) {
        const d = Math.hypot(pool[i].x - px, pool[i].y - py);
        if (d < myD) { myD = d; myI = gi; myA = pool[i]; } } });
      if (myI < 0 || myD > 12) continue;
      let ot = null, otD = Infinity;
      islands.forEach((idx, gi) => { if (gi === myI) return; for (const i of idx) {
        const d = Math.hypot(pool[i].x - myA.x, pool[i].y - myA.y);
        if (d < otD) { otD = d; ot = pool[i]; } } });
      if (!ot || otD > MAX_GAP) continue;
      try {
        await eda.pcb_PrimitiveLine.create(net, layer, myA.x, myA.y, ot.x, ot.y, STITCH_W);
        fixed++;
        acts.push({ net, layer, stitch: true, gap: Math.round(otD), islands: islands.length });
      } catch (e) { acts.push({ net, err: String(e && e.message).slice(0, 90) }); }
      break;
    }
  }
  if (!fixed) break;
  try { await eda.pcb_PrimitivePour.rebuildAllCopperRegions(); } catch (e) {}
  await new Promise(r => setTimeout(r, 800));
}

// ---- 间距：缩窄 + 绕行 ----
for (let round = 0; round < 4; round++) {
  const s = await scan();
  const clears = s.flat.filter(x => x.errorType === 'Clearance Error');
  if (!clears.length) break;
  let fixed = 0;
  const seen = new Set();
  for (const v of clears) {
    const ed = v.explanation?.errData || {};
    const tid = ed.obj1Type === 'Track' ? ed.obj1 : (ed.obj2Type === 'Track' ? ed.obj2 : null);
    if (!tid || seen.has(tid)) continue;
    seen.add(tid);
    try {
      const tl = await eda.pcb_PrimitiveLine.get(tid);
      if (!tl) continue;
      const w = Number(tl.getState_LineWidth?.() ?? 0);
      if (w > 6.5) {
        await eda.pcb_PrimitiveLine.modify(tid, { lineWidth: 6.5 });
        fixed++; acts.push({ line: tid, thinned: [w, 6.5] }); continue;
      }
      const padId = ed.obj1Type === 'SMD Pad' ? ed.obj1 : (ed.obj2Type === 'SMD Pad' ? ed.obj2 : null);
      if (!padId) continue;
      const pad = await eda.pcb_PrimitivePad.get(padId);
      if (!pad) continue;
      const raw = pad.getState_Pad?.();
      const verts = [];
      if (Array.isArray(raw) && Array.isArray(raw[1])) {
        const a = raw[1];
        for (let i = 0; i < a.length - 1; i++)
          if (typeof a[i] === 'number' && typeof a[i+1] === 'number') verts.push([a[i], a[i+1]]);
      }
      if (verts.length < 3) continue;
      const xs = verts.map(q => q[0]), ys = verts.map(q => q[1]);
      const bx0 = Math.min(...xs), bx1 = Math.max(...xs);
      const by0 = Math.min(...ys), by1 = Math.max(...ys);
      const NEED = 6 + 3.25 + 1.0;
      const sx = Number(tl.getState_StartX()), sy = Number(tl.getState_StartY());
      const ex = Number(tl.getState_EndX()), ey = Number(tl.getState_EndY());
      const net = String(tl.getState_Net?.() || '');
      const layer = tl.getState_Layer?.() ?? 1;
      const cx = bx0 - NEED;
      if (!(cx < bx0 - NEED + 0.2)) continue;
      await eda.pcb_PrimitiveLine.modify(tid, { endX: cx, endY: sy });
      await eda.pcb_PrimitiveLine.create(net, layer, cx, sy, cx, ey, 6.5);
      await eda.pcb_PrimitiveLine.create(net, layer, cx, ey, ex, ey, 6.5);
      fixed++;
      acts.push({ line: tid, rerouted: Math.round(cx), padBBox: [Math.round(bx0), Math.round(by0), Math.round(bx1), Math.round(by1)] });
    } catch (e) { acts.push({ tid, err: String(e && e.message).slice(0, 90) }); }
  }
  if (!fixed) break;
  try { await eda.pcb_PrimitivePour.rebuildAllCopperRegions(); } catch (e) {}
  await new Promise(r => setTimeout(r, 1000));
}

await eda.pcb_Document.save();
await new Promise(r => setTimeout(r, 2000));
try { await eda.pcb_PrimitivePour.rebuildAllCopperRegions(); } catch (e) {}
await new Promise(r => setTimeout(r, 2500));
const after = await scan();
return {
  before: { passed: before.passed, broken: before.broken, clearance: before.clearance, other: before.other },
  after: { passed: after.passed, broken: after.broken, clearance: after.clearance, other: after.other },
  leftover: after.flat.slice(0, 6).map(x => ({ t: x.errorType,
    min: x.explanation?.param?.minDistance, should: x.explanation?.param?.shouldBe })),
  acts: acts.slice(0, 25),
};
`;

const tmp = path.join(ROOT, 'scripts', '_reheal.js');
fs.writeFileSync(tmp, body, 'utf8');
const args = ['invoke', '--code-file', tmp, '--args', JSON.stringify({ uuid }), '--timeout', '420000'];
if (session) args.push('--session', session);
const r = spawnSync(CLI, args, {
  cwd: ROOT, encoding: 'utf8', timeout: 900000,
  maxBuffer: 32 * 1024 * 1024, windowsHide: true,
});
console.log((r.stdout || '').slice(0, 16000));
if (r.stderr) console.log('--- stderr ---\n' + r.stderr.slice(0, 3000));
fs.unlinkSync(tmp);
