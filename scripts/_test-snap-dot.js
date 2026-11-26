// 证明 snapEnds 的退化线段处置**真的会触发** —— 不是读代码猜。
// 做法：把 pipeline3.js 里真实的 snapEnds 代码块整段切出来，喂假 eda/log/sleep/left 跑。
// 夹具用的是 d10 实测坐标（来自 out\ESP32C3_Minimal-20261125-224535\_log.json 的 connDiag）。
const fs = require('fs');
const P = process.argv[2];
const src = fs.readFileSync(P, 'utf8');

const a0 = src.indexOf("phase('snapEnds');");
const aC = src.lastIndexOf('// ---------- 8.2 走线端点吸附 ----------', a0);
const a = aC >= 0 ? aC : a0;
const endMark = "} catch (e) { log('snapFail', String(e && e.message).slice(0, 150)); }";
const b = src.indexOf(endMark, a);
if (a < 0 || b < 0) { console.log('切不出 snapEnds 段，a=' + a + ' b=' + b); process.exit(1); }
const block = src.slice(a, b + endMark.length);

// 每轮跑一份全新的假板子
// deleteRet: 假 delete 的返回值。真实 API 签名是 Promise<boolean>，失败时 resolve(false)
// 而不是抛错 —— 所以夹具必须能模拟 false，否则"忽略返回值"的缺陷永远测不出来。
// modifyUndef: 假 modify 返回 undefined（真实 API 的失败信号，同样不抛）。
// 同理：夹具若永远返回对象，`modify` 不看返回值这个缺陷也永远测不出来。
function makeEda(lines, vias, deleteRet, modifyUndef) {
  const del = [], mod = [];
  const st = (o) => ({
    getState_Net: () => o.net,
    getState_Layer: () => (o.layer === undefined ? 1 : o.layer),
    getState_LineWidth: () => 10,
    getState_StartX: () => o.sx, getState_StartY: () => o.sy,
    getState_EndX: () => o.ex, getState_EndY: () => o.ey,
  });
  const eda = {
    pcb_PrimitivePad: { getAllPrimitiveId: async () => [], get: async () => null },
    pcb_PrimitiveVia: {
      getAllPrimitiveId: async () => vias.map(v => v.id),
      get: async (id) => {
        const v = vias.find(z => z.id === id);
        if (!v) return null;
        return { getState_Net: () => v.net, getState_X: () => v.x, getState_Y: () => v.y };
      },
    },
    pcb_PrimitiveLine: {
      getAllPrimitiveId: async () => lines.map(l => l.id),
      get: async (id) => { const l = lines.find(z => z.id === id); return l ? st(l) : null; },
      modify: async (id, o) => {
        mod.push({ id, ...o });
        return modifyUndef ? undefined : { getState_PrimitiveId: () => id };
      },
      delete: async (id) => { del.push(id); return deleteRet; },
    },
  };
  return { eda, del, mod };
}

async function run(lines, vias, deleteRet, modifyUndef) {
  const { eda, del, mod } = makeEda(lines, vias, deleteRet === undefined ? true : deleteRet, !!modifyUndef);
  const logs = [];
  // 必须 return 且必须 () 调用：new Function 的函数体是**语句序列**，
  // 表达式语句的值不会被返回 —— 只写 (async()=>{...}) 既不执行也拿不到 promise。
  const fn = new Function('eda', 'log', 'sleep', 'left', 'phase',
    'return (async()=>{' + block + '\n})()');
  await fn(eda, (k, v) => logs.push({ k, v }), async () => { }, () => 600000, () => { });
  const snapLog = logs.find(l => l.k === 'snappedLines');
  return { del, mod, logs, snap: snapLog && snapLog.v };
}

// d10 实测几何：3V3 两条线长 0.01mil，过孔 c542077a 在 (1226.7005,-1018.927)
const V3 = { id: 'c542077a73475b31', net: '3V3', x: 1226.7005, y: -1018.9274119191974 };
const VLED = { id: '5606e00a3f8f7b1c', net: 'LED_A', x: 1384.1805, y: -335.8575 };

const CASES = [
  {
    name: 'd10 实测的两条 0.01mil 退化线 → 两条都删掉',
    vias: [V3],
    lines: [
      { id: 'ea9e36113b1b0550', net: '3V3', sx: 1226.7068841582823, sy: -1018.9274119191974, ex: 1226.6968841836824, ey: -1018.9274119191974 },
      { id: '92597cae3e36efa9', net: '3V3', sx: 1226.6968841836824, sy: -1018.9274119191974, ex: 1226.7068841582823, ey: -1018.9274119191974 },
    ],
    wantDel: ['ea9e36113b1b0550', '92597cae3e36efa9'], wantDot: 2,
  },
  {
    name: '两端会被吸到同一过孔的长线（0.8mil）→ 删掉，不能留成铜点',
    vias: [VLED],
    lines: [{ id: 'L0', net: 'LED_A', sx: 1384.1805, sy: -335.8575, ex: 1384.9805, ey: -335.8575 }],
    wantDel: ['L0'], wantDot: 1,
  },
  {
    name: '正常 40mil 线，一端偏 1mil → 只吸附，绝不删',
    vias: [VLED],
    // 起点故意偏过孔 1mil（在 SNAP=1.5 内），终点离得远
    lines: [{ id: 'L1', net: 'LED_A', sx: 1385.1805, sy: -335.8575, ex: 1424.1805, ey: -335.8575 }],
    wantDel: [], wantDot: 0, wantMod: ['L1'],
  },
  {
    name: '布线器直接输出的零长线（未发生吸附）→ 也要删',
    vias: [],
    lines: [{ id: 'L2', net: 'GND', sx: 500, sy: 500, ex: 500.3, ey: 500 }],
    wantDel: ['L2'], wantDot: 1,
  },
  {
    // 旧键漏层号：这两条会被判成重复，后一条被 continue 掉 → 端点误差留在板上（半修）
    name: '同网同端点但不同层 → 两条都必须吸附，不能当成重复',
    vias: [VLED],
    lines: [
      { id: 'T1', net: 'LED_A', layer: 1, sx: 1385.1805, sy: -335.8575, ex: 1424.1805, ey: -335.8575 },
      { id: 'B1', net: 'LED_A', layer: 2, sx: 1385.1805, sy: -335.8575, ex: 1424.1805, ey: -335.8575 },
    ],
    wantDel: [], wantDot: 0, wantMod: ['T1', 'B1'], wantDup: 0,
  },
  {
    name: '同网同层同端点 → 计为重复，但仍要写回（不跳过的幂等吸附）',
    vias: [VLED],
    lines: [
      { id: 'T2', net: 'LED_A', layer: 1, sx: 1385.1805, sy: -335.8575, ex: 1424.1805, ey: -335.8575 },
      { id: 'T3', net: 'LED_A', layer: 1, sx: 1385.1805, sy: -335.8575, ex: 1424.1805, ey: -335.8575 },
    ],
    wantDel: [], wantDot: 0, wantMod: ['T2', 'T3'], wantDup: 1,
  },
  {
    // 真实 API 失败时 resolve(false) 而非抛错。旧写法无条件 snapDot++ → 虚报"已删"。
    // 新写法只认 === true：dotDeleted 必须是 0，并且留下 snapDotDelUnconfirmed。
    name: 'delete 返回 false（真实 API 的失败信号）→ 不能算已删，必须单独上报',
    vias: [VLED],
    lines: [{ id: 'L9', net: 'GND', sx: 500, sy: 500, ex: 500.2, ey: 500 }],
    wantDel: ['L9'], wantDot: 0, deleteRet: false, wantUnconfirmed: 1,
  },
  {
    // 真实 API 的 modify 失败同样不抛，而是 resolve(undefined)。
    // 旧写法不看返回值，直接 snapCount++ → 日志说"吸附了 N 条"，板上端点其实没动。
    // 这条用例就是那个缺陷的唯一可证伪形式：调用确实发生，但绝不能计数。
    name: 'modify 返回 undefined（真实 API 的失败信号）→ 不能算已吸附，必须单独上报',
    vias: [VLED],
    lines: [{ id: 'M1', net: 'LED_A', sx: 1385.1805, sy: -335.8575, ex: 1424.1805, ey: -335.8575 }],
    wantDel: [], wantDot: 0, wantMod: ['M1'], modifyUndef: true,
    wantSnapped: 0, wantModUnconfirmed: 1,
  },
];

(async () => {
  let pass = 0;
  for (const c of CASES) {
    const r = await run(c.lines, c.vias, c.deleteRet, c.modifyUndef);
    const got = [...r.del].sort().join(',');
    const want = [...c.wantDel].sort().join(',');
    const dotOK = r.snap && r.snap.dotDeleted === c.wantDot;
    const modOK = !c.wantMod || c.wantMod.every(id => r.mod.some(m => m.id === id));
    // 日志键已更名：dupSkipped（旧的"跳过"语义）→ dupSeen（"检出重复但仍写回"）
    const dupOK = c.wantDup === undefined || (r.snap && r.snap.dupSeen === c.wantDup);
    const uncN = r.logs.filter(l => l.k === 'snapDotDelUnconfirmed').length;
    const uncOK = c.wantUnconfirmed === undefined || uncN === c.wantUnconfirmed;
    // 新增：modify 未确认
    const modUncN = r.logs.filter(l => l.k === 'snapModifyUnconfirmed').length;
    const modUncOK = c.wantModUnconfirmed === undefined || modUncN === c.wantModUnconfirmed;
    // 新增：snapped 计数必须等于真实写回成功的条数
    const snapOK = c.wantSnapped === undefined || (r.snap && r.snap.snapped === c.wantSnapped);
    const delOK = got === want;
    if (delOK && dotOK && modOK && dupOK && uncOK && modUncOK && snapOK) {
      pass++;
    } else {
      console.log(`  FAIL ${c.name}: 删=[${got}] 应=[${want}] dotDeleted=${r.snap && r.snap.dotDeleted}/${c.wantDot}` +
        ` dup=${r.snap && r.snap.dupSeen}${c.wantDup === undefined ? '' : '/' + c.wantDup}` +
        ` snapped=${r.snap && r.snap.snapped}${c.wantSnapped === undefined ? '' : '/' + c.wantSnapped}` +
        (uncOK ? '' : ` delUnconfirmed=${uncN}/${c.wantUnconfirmed}`) +
        (modUncOK ? '' : ` modUnconfirmed=${modUncN}/${c.wantModUnconfirmed}`));
    }
  }
  console.log(`  ${pass}/${CASES.length} 通过`);

  // 关键不变式：任何被删的线长度都必须 < 1mil；任何被 modify 的线长度都必须 ≥ 1mil
  const check = await run(
    [{ id: 'X', net: 'GND', sx: 500, sy: 500, ex: 500.2, ey: 500 },
     { id: 'Y', net: 'GND', sx: 600, sy: 600, ex: 600.2, ey: 600 }],
    [], true);
  const zeroLenMod = check.mod.filter(m => m.startX !== undefined &&
    Math.hypot(m.endX - m.startX, m.endY - m.startY) < 1);
  if (zeroLenMod.length === 0) {
    console.log('  反向：两条退化线已删除，且没有留下任何零长 modify ✓');
  } else { console.log('  FAIL 反向检查：零长 modify=' + zeroLenMod.length); process.exit(1); }

  // 走廊退化守卫顺序：所有「长度 ~0 → continue」都必须排在 geoDistSeg 之前，
  // 否则会先拿一条长度 0、宽 6.5mil 的线去算距离。
  // 这里锁**真实代码片段**而不是注释：注释会随重构改写（2026-11-25 把 axis='y'
  // 的拓扑修对时就顺手改了注释，锁当场失效 —— 而当时代码其实是对的）。
  // 现在要求三条守卫齐全且严格递增，geoDistSeg 在最后。
  const guards = [
    ['中段退化', 'Math.hypot(mid[2] - mid[0], mid[3] - mid[1]) < 1'],
    ['腿1退化', 'Math.hypot(corner1[0] - sx, corner1[1] - sy) < 0.01'],
    ['腿2退化', 'Math.hypot(ex - corner2[0], ey - corner2[1]) < 0.01'],
  ].map(([name, needle]) => ({ name, at: src.indexOf(needle) }));
  const geoAt = src.indexOf('geoDistSeg', guards[guards.length - 1].at);
  const missing = guards.filter(g => g.at < 0).map(g => g.name);
  let orderOk = missing.length === 0 && geoAt > guards[guards.length - 1].at;
  for (let i = 1; i < guards.length; i++) if (!(guards[i].at > guards[i - 1].at)) orderOk = false;
  if (orderOk) {
    console.log('  走廊退化守卫顺序（中段 < 腿1 < 腿2 < geoDistSeg）：✓');
  } else {
    console.log('  FAIL 走廊退化守卫顺序 缺失=[' + missing.join(',') + '] ' +
      guards.map(g => g.name + '=' + g.at).join(' ') + ' geo=' + geoAt);
    process.exit(1);
  }

  process.exit(pass === CASES.length ? 0 : 1);
})();
