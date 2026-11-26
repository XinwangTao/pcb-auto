/**
 * 用「连通分量」思路补断线缺口 —— 这才是正确解法。
 *
 * ## 为什么不能只找最近锚点
 * 第一次尝试失败了：断点附近的最近锚点距离只有 1 mil（就是那条 1mil 碎片走线的
 * 另一端），于是每轮都在同一个 1mil 缺口上来回补线，6 轮补了 12 条 1mil 线，
 * DRC 依然 false。真实缺口是 **23.6 mil**（2106.9 → 2130.5），
 * 但它不是"离断点最近"的那个点。
 *
 * ## 正确做法
 * 1. 把每个网的铜（焊盘 / 过孔 / 走线端点）按几何连通性聚成 **孤岛**
 *    （同层且距离 ≤ MERGE 视作连通）
 * 2. DRC 报的断点属于哪个孤岛 → 找**另一个孤岛**里离它最近的锚点
 * 3. 只跨孤岛补线，且距离 ≤ MAX_GAP
 * 这样补出来的线一定跨越真实断口，而不是在孤岛内部重复描。
 *
 * 用法：node try-stitch.js <out目录名> [sessionId]
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
const dirName = process.argv[2];
const session = process.argv[3];
if (!dirName) { console.error('用法: node try-stitch.js <out目录名> [sessionId]'); process.exit(2); }

const runJson = path.join(ROOT, 'out', dirName, '_run.json');
const uuid = JSON.parse(fs.readFileSync(runJson, 'utf8')).projectUuid;

const body = `
const A = __CLI__.args;
await eda.dmt_Project.openProject(A.uuid);
await new Promise(r => setTimeout(r, 2500));
const pcbs = await eda.dmt_Pcb.getAllPcbsInfo();
await eda.dmt_EditorControl.openDocument(pcbs[0].uuid);
await eda.dmt_EditorControl.waitForDocumentReady(pcbs[0].uuid, 60000);
await new Promise(r => setTimeout(r, 1500));

const before = await eda.pcb_Drc.check(true, false, false);

const MERGE = 2;        // 同层距离 ≤2mil 视为同一孤岛（走线端点/焊盘中心的正常接触误差）
const MAX_GAP = 150;    // 跨岛补线的最大距离
const STITCH_W = 12;

// ---- 1. 收集锚点 ----
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
    if (!n) continue;
    const layer = l.getState_Layer?.() ?? 1;
    // 走线中间的点也要算锚点，否则长线中段附近的断点找不到"岛"
    const sx = Number(l.getState_StartX()), sy = Number(l.getState_StartY());
    const ex = Number(l.getState_EndX()), ey = Number(l.getState_EndY());
    add(n, sx, sy, layer, id); add(n, ex, ey, layer, id);
    add(n, (sx + ex) / 2, (sy + ey) / 2, layer, id);
  } catch (e) {}
}

// ---- 2. 并查集聚孤岛（按网 + 层）----
function buildIslands(pool) {
  const parent = pool.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const uni = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      if (Math.hypot(pool[i].x - pool[j].x, pool[i].y - pool[j].y) <= MERGE) uni(i, j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < pool.length; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  return [...groups.values()];
}

const actions = [];
let stitched = 0;
for (let round = 0; round < 6; round++) {
  let details = null;
  try { details = await eda.pcb_Drc.check(true, false, true); } catch (e) { break; }
  const flat = [];
  const walk = (n) => {
    if (!n) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.errorType === 'Connection Error') flat.push(n);
    if (n.list) walk(n.list);
  };
  walk(details);
  if (!flat.length) { actions.push({ round, remaining: 0, done: true }); break; }

  let fixed = 0;
  for (const v of flat) {
    if (fixed >= 6) break;
    const ed = v.explanation?.errData || {};
    // DRC 坐标是真实坐标的 1/10
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

      // 断点属于哪个岛：取岛内离断点最近的锚点
      let myIsland = -1, myD = Infinity, myAnchor = null;
      islands.forEach((idx, gi) => {
        for (const i of idx) {
          const d = Math.hypot(pool[i].x - px, pool[i].y - py);
          if (d < myD) { myD = d; myIsland = gi; myAnchor = pool[i]; }
        }
      });
      if (myIsland < 0 || myD > 12) continue;

      // 找别的岛里离 myAnchor 最近的点
      let other = null, otherD = Infinity;
      islands.forEach((idx, gi) => {
        if (gi === myIsland) return;
        for (const i of idx) {
          const d = Math.hypot(pool[i].x - myAnchor.x, pool[i].y - myAnchor.y);
          if (d < otherD) { otherD = d; other = pool[i]; }
        }
      });
      if (!other || otherD > MAX_GAP) {
        actions.push({ net, layer, skip: 'no island within MAX_GAP', otherD: Math.round(otherD) });
        continue;
      }

      try {
        await eda.pcb_PrimitiveLine.create(net, layer,
          myAnchor.x, myAnchor.y, other.x, other.y, STITCH_W);
        fixed++; stitched++;
        actions.push({ net, layer, ok: true,
          from: [Math.round(myAnchor.x), Math.round(myAnchor.y)],
          to: [Math.round(other.x), Math.round(other.y)],
          gap: Math.round(otherD), islands: islands.length });
      } catch (e) { actions.push({ net, layer, err: String(e && e.message).slice(0, 100) }); }
      break;   // 每个断点只补一层
    }
  }
  actions.push({ round, broken: flat.length, fixed });
  if (!fixed) break;
  try { await eda.pcb_PrimitivePour.rebuildAllCopperRegions(); } catch (e) {}
  await new Promise(r => setTimeout(r, 700));
}

await eda.pcb_Document.save();
await new Promise(r => setTimeout(r, 1800));
try { await eda.pcb_PrimitivePour.rebuildAllCopperRegions(); } catch (e) {}
await new Promise(r => setTimeout(r, 1800));

const after = await eda.pcb_Drc.check(true, false, false);
return { before, after, stitched, actions: actions.slice(0, 40) };
`;

const tmp = path.join(ROOT, 'scripts', '_try_stitch.js');
fs.writeFileSync(tmp, body, 'utf8');
const args = ['invoke', '--code-file', tmp, '--args', JSON.stringify({ uuid })];
if (session) args.push('--session', session);
const r = spawnSync(CLI, args, {
  cwd: ROOT, encoding: 'utf8', timeout: 900000,
  maxBuffer: 32 * 1024 * 1024, windowsHide: true,
});
console.log((r.stdout || '').slice(0, 16000));
if (r.stderr) console.log('--- stderr ---\n' + r.stderr.slice(0, 3000));
fs.unlinkSync(tmp);
