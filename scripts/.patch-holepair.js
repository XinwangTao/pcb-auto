// 给 pipeline3.js 加一个 Hole × Hole 处理者（两侧都是孔，原有两个环都认不了）
// 依据：out\_d12-holepairs.md（末障碍 Hole×Hole 11.701/11.811，只差 0.11 mil，
// 过孔可动、J1 槽孔不可动 ⇒ 把过孔沿"背离另一孔"的方向推开 1~2 mil）
const fs = require('fs');
const F = process.argv[2];
let s = fs.readFileSync(F, 'utf8');
function rep(name, from, to) {
  const n = s.split(from).length - 1;
  if (n === 0) { console.error('✗ 锚点缺失: ' + name); process.exit(3); }
  if (n > 1) { console.error('✗ 锚点不唯一(' + n + '): ' + name); process.exit(4); }
  s = s.replace(from, to);
  console.log('✓ ' + name);
}

// ---- 1) 处理者本体：插在 Via 环之前 ----
rep('插入 Hole×Hole 处理者',
`const allUnclaimable = unclaimable.length > 0 && unclaimable.length >= clears.length;`,
`const allUnclaimable = unclaimable.length > 0 && unclaimable.length >= clears.length;
    // 【Hole × Hole 处理者：两侧都是孔，两个老环都不认领】
    // d12 实测（out\\_d12-holepairs.md）：两条违规都在**流水线自己打的 GND 过孔**与
    // J1 USB-C 壳体槽孔之间，cur=11.701 / need=11.811，只差 0.11 mil。
    // obj1Type/obj2Type 都是 'Hole' ⇒ Via 环（要求含 Via）与 Track 环（要求含 Track）
    // 全部 continue，于是两轮 fixed=2/2 而违规 4→4 一格没降 —— 病根是**没有处理者**，
    // 不是修不动。过孔可动、槽孔不可动，所以按下述最小改动推开过孔：
    //   · 方向：at 是缺口最近点，过孔心相对 at 的方向就是"背离另一孔"。
    //     报告核对过 at 的取整位置与"缺口线段中点"反推值逐位吻合，12.2 mil 的距离也够定方向。
    //   · 步长：ceil(need - cur + 1) mil，封顶 6 mil。报告实测位移 >6 mil 时走线端帽
    //     会离开焊盘，必须同步改线端点；这里不改线，所以不越这条线。
    //   · 不用缩孔替代：12 → 11.8 只补 0.1 mil，仍差 0.0098，且 11.8 已是可制造下限。
    //     这就是"越缩越像能过、实际永远差一点"的量化陷阱。
    let holePairN = 0, holePairFixed = 0;
    const holePairs = clears.filter((v) => {
      const e = v.explanation?.errData || {};
      return e.obj1Type === 'Hole' && e.obj2Type === 'Hole';
    });
    if (holePairs.length) {
      holePairN = holePairs.length;
      // 过孔位置索引每轮建一次；get 失败/读数缺失一律跳过，不外推成"没有孔"
      let viaGeo = null;
      const loadVias = async () => {
        if (viaGeo) return viaGeo;
        viaGeo = [];
        try {
          const ids = await eda.pcb_PrimitiveVia.getAllPrimitiveId();
          for (const id of (ids || [])) {
            try {
              const o = await eda.pcb_PrimitiveVia.get(id);
              if (!o) continue;
              const x = Number(o.getState_X?.());
              const y = Number(o.getState_Y?.());
              if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
              viaGeo.push({ id: String(id), x, y });
            } catch (e) { }
          }
        } catch (e) {
          log('holePairViaIndexErr', { m: String(e && e.message).slice(0, 100) });
        }
        return viaGeo;
      };
      for (const v of holePairs) {
        const e = v.explanation?.errData || {};
        const needDist = Number(e.clearance) * 10;      // 画布单位 mil/10 → mil
        const curDist = Number(e.minDistance) * 10;
        const p = e.position || {};
        const ax = Number(p.x), ay = Number(p.y);
        if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(needDist) || !Number.isFinite(curDist)) {
          log('holePairNoCoord', { need: String(e.clearance), cur: String(e.minDistance) });
          continue;
        }
        const deficit = needDist - curDist;
        if (!(deficit > 0)) { log('holePairOdd', { diameter: needDist, actual: curDist, at: [ax, ay] }); continue; }
        const delta = Math.min(6, Math.max(1, Math.ceil(deficit + 1)));
        if (deficit + 1 > 6) { log('holePairTooFar', { deficit, at: [ax, ay] }); continue; }
        // 找最近的、可动的过孔
        const vias = await loadVias();
        let best = null;
        for (const g of vias) {
          const d = Math.hypot(g.x - ax, g.y - ay);
          if (!best || d < best.d) best = { d, g };
        }
        if (!best || !(best.d <= 40)) {
          log('holePairNoVia', { at: [ax, ay], near: best ? Math.round(best.d * 100) / 100 : -1, vias: vias.length });
          continue;
        }
        const g = best.g;
        const ux = g.x - ax, uy = g.y - ay;
        const len = Math.hypot(ux, uy);
        if (!(len > 0.01)) { log('holePairDegenerate', { at: [ax, ay], via: [g.x, g.y] }); continue; }
        const ox = g.x, oy = g.y;
        const nx = Math.round((ox + (ux / len) * delta) * 1e4) / 1e4;
        const ny = Math.round((oy + (uy / len) * delta) * 1e4) / 1e4;
        try {
          // modify 失败 resolve(undefined) 而不抛 ⇒ 必须判返回值（staticcheck §1.5）
          const mr = await eda.pcb_PrimitiveVia.modify(g.id, { x: nx, y: ny });
          if (mr === undefined) { log('holePairModifyFail', { id: g.id, to: [nx, ny] }); continue; }
          // 回滚要能把它推回原位：记录旧坐标
          recMod(g.id, { kind: 'viaMoved', x: ox, y: oy, to: [nx, ny] });
          g.x = nx; g.y = ny;
          fixed++;
          holePairFixed++;
          log('holePairNudged', { id: g.id, delta, from: [ox, oy], at: [ax, ay], to: [nx, ny] });
        } catch (err) {
          log('holePairModifyErr', { id: g.id, m: String(err && err.message).slice(0, 100) });
        }
      }
      if (holePairN) log('holePairSummary', { total: holePairN, fixed: holePairFixed });
    }`);

// ---- 2) 回滚要能把平移过的过孔推回原位 ----
rep('回滚支持 viaMoved',
`      if (m.kind === 'viaDeleted') {`,
`      if (m.kind === 'viaMoved') {
          // 【平移过的过孔要推回原坐标】与 viaDeleted 不同，这里不需要 create：
          // 对象还在板上，modify 回旧坐标就是精确的逆操作（旧坐标在 recMod 时已记下）。
          // modify 失败同样 resolve(undefined) 而不抛，"没抛"不等于"回去了"。
          const bx = Number(m.x), by = Number(m.y);
          if (!Number.isFinite(bx) || !Number.isFinite(by)) { viaUnrestorable.push(m.id); continue; }
          try {
            const mr = await eda.pcb_PrimitiveVia.modify(m.id, { x: bx, y: by });
            if (mr === undefined) viaRestoreFail.push(m.id); else rb.viaRestored++;
          } catch (e) { viaRestoreFail.push(m.id); }
          continue;
        }
      if (m.kind === 'viaDeleted') {`);

fs.writeFileSync(F, s, 'utf8');
console.log('  ' + fs.statSync(F).size + ' B');
