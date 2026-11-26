// 一次性原子改写 pipeline3.js 的三处（避免多次 edit 留下的中间态窗口）。
// 用完即删；失败不写盘。
const fs = require('fs');
const P = process.argv[2];
let s = fs.readFileSync(P, 'utf8');
const before = s.length;

const reps = [
  // A) 过孔几何补上 盘径 / 孔型：slot-geo 核实的判据需要它们
  [`        geo.set(String(id), { k: 'via', net: n, layer: null,
          x: Number(vv.getState_X()), y: Number(vv.getState_Y()) });`,
   `        // dia / viaType 是 slot-geo 在 api-types.d.ts:15434 / 15460 核实过的读法。
        // 内核判连通只看"线端是否落在过孔盘(dia/2)内"和"孔是否覆盖该层"，
        // 不看中心距 —— 少了这两个值就永远解释不了"贴在一起却报不连通"。
        geo.set(String(id), { k: 'via', net: n, layer: null,
          dia: Number(vv.getState_Diameter?.()), viaType: Number(vv.getState_ViaType?.()),
          x: Number(vv.getState_X()), y: Number(vv.getState_Y()) });`],

  // B) 单对象断连：用同网的另一条单对象错误补出另一端（诊断用）
  [`    const nameNet = String(net).toUpperCase();
    const o1 = geo.get(String(ed.obj1 || ''));
    const o2 = geo.get(String(ed.obj2 || ''));
    if (!o1 || !o2) {
      log('patchNoGeo', { net, o1: String(ed.obj1 || ''), t1: ed.obj1Type || null,
        o2: String(ed.obj2 || ''), t2: ed.obj2Type || null,
        has1: !!o1, has2: !!o2, indexed: geo.size });
      continue;
    }`,
   `    const nameNet = String(net).toUpperCase();
    // 【单对象断连：配对补出另一端】\`IPCB_ViolationBase.obj2\` 是**可选字段**
    // （api-types.d.ts:8346），内核不保证给全。d13 实测 2 处 SDA 断连各自只带 1 个
    // 对象（一条过孔 6a999d…、一条走线 56e379…），两者中心距 0，于是旧代码走
    // patchNoGeo 直接放弃。同网同时出现两条"各带一个不同 id 的单对象错误"，
    // 它们就是被拆开上报的同一对。这里只用于**诊断配对**，不据此直接补铜。
    const obj2Raw = String(ed.obj2 || '');
    let obj2Synth = '';
    if (!obj2Raw) {
      const myId = String(ed.obj1 || '');
      const peer = connErrs.find(w => {
        const d2 = w.explanation?.errData || {};
        if (String(w.net || d2.net || '').toUpperCase() !== nameNet) return false;
        const pid = String(d2.obj1 || '');
        return !!pid && pid !== myId && !String(d2.obj2 || '');
      });
      if (peer) {
        const pd = peer.explanation?.errData || {};
        obj2Synth = String(pd.obj1 || '');
        log('patchPairSynth', { net, o1: myId, o2: obj2Synth,
          t1: ed.obj1Type || null, t2: pd.obj1Type || null });
      }
    }
    const o1 = geo.get(String(ed.obj1 || ''));
    const o2 = geo.get(obj2Raw || obj2Synth || '');
    if (!o1 || !o2) {
      log('patchNoGeo', { net, o1: String(ed.obj1 || ''), t1: ed.obj1Type || null,
        o2: obj2Raw, t2: ed.obj2Type || null, synth: obj2Synth || null,
        has1: !!o1, has2: !!o2, indexed: geo.size });
      continue;
    }`],

  // C) 贴合却报不连通：把过孔盘覆盖情况一起记下来（先观测，不改决策）
  [`    if (cp.d <= 1.0) {
      log('patchIslandPair', { net, d: Math.round(cp.d * 100) / 100,
        t1: ed.obj1Type || null, t2: ed.obj2Type || null,
        note: '两对象已贴合仍判不连通 → 死铜孤岛；局部补铜无效，需重铺/改策略' });
      continue;
    }`,
   `    if (cp.d <= 1.0) {
      // 过孔盘覆盖诊断（只观测）。slot-geo 依据 api-types.d.ts:15371/15434/15460 指出：
      // 内核只认"线端落在过孔盘 dia/2 内"且"孔覆盖该层"，net 相同 + 中心距 0
      // 并不构成连通。所以"贴着还不通"有两种可能，处理方式完全相反：
      //   ① 死铜孤岛 → 补铜无效，只能重铺/改策略；
      //   ② 过孔盘没盖住线端（r < 端点距离）或孔是盲埋孔不覆盖该层 → 改过孔或挪线端。
      // 先只记账不动作，攒够样本再决定，避免又一次没有依据的盲目补铜（d6 已白干过）。
      const viaSide = (o1.k === 'via') ? o1 : ((o2.k === 'via') ? o2 : null);
      let coverage = null;
      if (viaSide) {
        const other = (viaSide === o1) ? o2 : o1;
        const r = Number.isFinite(viaSide.dia) ? viaSide.dia / 2 : null;
        let dEnd = Infinity;
        for (const [px, py] of ptsOf(other)) {
          dEnd = Math.min(dEnd, Math.hypot(px - viaSide.x, py - viaSide.y));
        }
        coverage = { r, dEnd: Math.round(dEnd * 100) / 100,
          covered: r !== null && dEnd <= r, viaType: viaSide.viaType, other: other.k };
      }
      log('patchIslandPair', { net, d: Math.round(cp.d * 100) / 100,
        t1: ed.obj1Type || null, t2: ed.obj2Type || null,
        synth: obj2Synth || null, coverage,
        note: '两对象已贴合仍判不连通 → 死铜孤岛 或 过孔盘未覆盖线端；局部补铜无效' });
      continue;
    }`],
];

let failed = [];
for (let i = 0; i < reps.length; i++) {
  const [oldS, newS] = reps[i];
  const n = s.split(oldS).length - 1;
  if (n !== 1) { failed.push(`替换 ${i + 1} 命中 ${n} 次（应为 1）`); continue; }
  s = s.replace(oldS, newS);
}
if (failed.length) {
  console.log('  FAIL 未写盘：');
  failed.forEach(f => console.log('    ' + f));
  process.exit(1);
}
// 写之前先过一遍语法（按 CLI 的 async 包裹形态）
try { new (require('vm').Script)('(async()=>{' + s + '\n})', { filename: 'wrapped.js' }); }
catch (e) { console.log('  FAIL 语法错误，未写盘：' + e.message); process.exit(1); }
fs.writeFileSync(P, s, 'utf8');
console.log(`  写入成功 ${before} -> ${s.length} B（+${s.length - before}）`);
