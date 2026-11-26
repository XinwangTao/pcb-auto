// ══════════════════════════════════════════════════════════════════════════
// 【本脚本已于 2026-11-25 应用完毕，禁止重跑】
//
// 它内嵌的 6 个 hunk 模板里，rollbackLineFix / 整轮回滚的写法是**有缺陷的版本**：
//   delete 失败是 resolve(false)、modify 失败是 resolve(undefined)，两者都不抛异常，
//   所以「只要没抛就算成功」会把静默失败记成成功。
// 该缺陷已在 pipeline3.js 里按返回值逐处修正（`=== true` / `=== undefined`）。
//
// 风险：重跑本脚本会把旧写法原样写回 pipeline3.js，而它自带的自检只数
// `rollbackLineFix(` 的出现次数，**不检查返回值判断**，于是会打印"校验通过"。
// 这就是审计里点名的 P7 —— 一个能把修复撤销掉、还自称成功的工具。
//
// 保留而非删除：它是那段改动的来龙去脉。但必须显式 --force-applied 才能跑，
// 且跑前应先 diff 一遍 H 里的每个 OLD 与当前文件。
// ══════════════════════════════════════════════════════════════════════════
if (!process.argv.includes('--force-applied')) {
  console.error('拒绝执行：本补丁已应用，重跑会写回已修复的缺陷。确需重放请加 --force-applied。');
  process.exit(1);
}
// 原子应用 patch-tx-modrollback 的 6 个 hunk（缺陷 #3 / #4）。
// 全部 OLD 必须各命中恰好 1 次；补丁后整文件必须能作为 async 函数体解析；
// 任何一步不满足都不写盘。
const fs = require('fs');
const P = process.argv[2];
let s = fs.readFileSync(P, 'utf8');
const before = s.length;

const H = [];

// ---------- P1：recMod 加 kind + 新增 rollbackLineFix ----------
H.push([
`const recMod = (id, orig) => {
  if (!id) return;
  if (!roundMods.some(m => m.id === String(id))) roundMods.push({ id: String(id), ...orig });
};`,
`// kind 决定回滚时该调哪个 API：Line 靠 modify 改回尺寸/端点；Via 只能靠
// pcb_PrimitiveVia.modify({holeDiameter, diameter}) 改回原孔径/外径 —— create 会造出
// 一个**新 id**，等于换掉这个过孔，不算恢复；被删掉的 Via 没有任何 API 能复活。
// 旧记录只有 {id, lineWidth|endX/endY}，回滚循环一律按 Line 处理，
// 于是 via 的缩/删从来没进回滚清单，日志里的"已回滚"与板上状态脱钩。
const recMod = (id, orig) => {
  if (!id) return;
  const kind = (orig && orig.kind) || 'line';
  if (!roundMods.some(m => m.id === String(id))) roundMods.push({ id: String(id), kind, ...orig });
};`
]);

H.push([
`const recNew = (obj) => {
  try { const pid = obj && obj.getState_PrimitiveId && obj.getState_PrimitiveId(); if (pid) roundCreated.push(String(pid)); } catch (e) { }
};`,
`const recNew = (obj) => {
  try { const pid = obj && obj.getState_PrimitiveId && obj.getState_PrimitiveId(); if (pid) roundCreated.push(String(pid)); } catch (e) { }
};

// 绕行失败后的回滚：逐项核对每一步，不同成因用不同日志键。
// 旧实现把两次调用分别 \`catch (e) { }\` 吞掉：删不掉的新增铜留在板上变成悬空短线
// （自己还会触发新的间距违规），改不回的端点留下断头线（断网）；
// 而日志只有一句 trackDoglegRolledBack / trackRerouteRolledBack，与真正
// 回滚成功长得一模一样，离线统计会据此认为"绕行失败没留后遗症"。
// 不用 get() 复检删除结果：本节开头记的坑是 get() 对已不存在的 id 会抛
// 'primitiveId' TypeError，与"读不出"同一表现，拿它判定"已删"同样是猜。
const rollbackLineFix = async (where, trackId, net, made, ex, ey) => {
  const lineFail = [];
  for (const id of made.slice().reverse()) {
    try { await eda.pcb_PrimitiveLine.delete(id); } catch (e) { lineFail.push(String(id)); }
  }
  let modifyFail = null;
  try { await eda.pcb_PrimitiveLine.modify(trackId, { endX: ex, endY: ey }); }
  catch (e) { modifyFail = String(e && e.message).slice(0, 100); }
  if (lineFail.length) log('rollbackLineFail', { where, line: trackId, net, made: made.length, n: lineFail.length, ids: lineFail });
  if (modifyFail !== null) log('rollbackModifyFail', { where, line: trackId, net, m: modifyFail });
  if (!lineFail.length && modifyFail === null) log('rollbackOk', { where, line: trackId, net, made: made.length });
};`
]);

// ---------- P2：整轮回滚按 kind 分派 ----------
H.push([
`    const rb = { deleted: 0, restored: 0, from: prevClearCount, to: clears.length, fixedGivenBack: prevFixed };
    for (const cid of roundCreated.reverse()) {
      try { await eda.pcb_PrimitiveLine.delete(cid); rb.deleted++; } catch (e) { }
    }
    for (const m of roundMods.reverse()) {
      const patch = {};
      if (m.endX !== undefined) { patch.endX = m.endX; patch.endY = m.endY; }
      if (m.lineWidth !== undefined) patch.lineWidth = m.lineWidth;
      if (!Object.keys(patch).length) continue;
      try { await eda.pcb_PrimitiveLine.modify(m.id, patch); rb.restored++; } catch (e) { }
    }
    log('clearanceReverted', rb);
    clearanceFixes -= prevFixed;      // 让 clearanceFixes 反映板上真实留下的修复数
    prevFixed = 0;`,
`    // 回滚要逐项核对：只有**确认改回去**的动作才能从 clearanceFixes 里扣。
    // 旧实现无条件 \`clearanceFixes -= prevFixed\`，把已删除的 via 也算作"已恢复"，
    // 于是"板上真实留下的修复数"被系统性低估 —— 离线统计正是拿它判断策略优劣。
    const rb = { deleted: 0, restored: 0, viaRestored: 0, from: prevClearCount, to: clears.length,
      fixedRequested: prevFixed, fixedGivenBack: 0 };
    const delFail = [], restoreFail = [], viaRestoreFail = [], viaUnrestorable = [];
    for (const cid of roundCreated.reverse()) {
      try { await eda.pcb_PrimitiveLine.delete(cid); rb.deleted++; } catch (e) { delFail.push(String(cid)); }
    }
    for (const m of roundMods.reverse()) {
      if (m.kind === 'via') {
        // 过孔尺寸只有 modify 能改回去；before 是改之前的真值（记录点见 viaShrunk）
        const b = m.before || {};
        try {
          await eda.pcb_PrimitiveVia.modify(m.id, { holeDiameter: b.holeDiameter, diameter: b.diameter });
          rb.viaRestored++;
        } catch (e) { viaRestoreFail.push(m.id); }
        continue;
      }
      if (m.kind === 'viaDeleted') {
        // 删除没有逆操作：不调 modify（对不存在的 id 只会抛），也不假装恢复。
        // 这条 via 确实不在板上了，它对应的那处"修复"依然算数，不能从计数里扣。
        viaUnrestorable.push(m.id);
        continue;
      }
      const patch = {};
      if (m.endX !== undefined) { patch.endX = m.endX; patch.endY = m.endY; }
      if (m.lineWidth !== undefined) patch.lineWidth = m.lineWidth;
      if (!Object.keys(patch).length) continue;
      try { await eda.pcb_PrimitiveLine.modify(m.id, patch); rb.restored++; } catch (e) { restoreFail.push(m.id); }
    }
    // 一处修复只算一次：绕行走 = 1 条 modify + 2 条 create，删除新增线段是
    // "撤掉多出来的铜"的前置动作，按 create 计数会把一处修复扣成两三处。
    rb.fixedGivenBack = rb.restored + rb.viaRestored;
    log('clearanceReverted', rb);
    if (delFail.length) log('clearanceRevertDeleteFail', { n: delFail.length, ids: delFail });
    if (restoreFail.length) log('clearanceRevertLineRestoreFail', { n: restoreFail.length, ids: restoreFail });
    if (viaRestoreFail.length) log('clearanceRevertViaRestoreFail', { n: viaRestoreFail.length, ids: viaRestoreFail });
    if (viaUnrestorable.length) log('clearanceRevertViaUnrestorable', { n: viaUnrestorable.length, ids: viaUnrestorable });
    clearanceFixes -= rb.fixedGivenBack;      // 只退确认退掉的；删掉的 via 仍在板上
    if (clearanceFixes < 0) {
      // 负数 = 记录数比实际 fixed 多，属记账漂移；不能静默夹成 0 让人以为对得上
      log('clearanceFixesNegative', { fixes: clearanceFixes, givenBack: rb.fixedGivenBack });
      clearanceFixes = 0;
    }
    prevFixed = 0;`
]);

// ---------- P3：viaShrunk 记录原值 ----------
H.push([
`        await eda.pcb_PrimitiveVia.modify(viaObjId, { holeDiameter: 11.8, diameter: 19.7 });
        fixed++;
        log('viaShrunk', { via: viaObjId, from: [curH, curD], to: [11.8, 19.7] });`,
`        await eda.pcb_PrimitiveVia.modify(viaObjId, { holeDiameter: 11.8, diameter: 19.7 });
        // 缩过孔是**改尺寸**，能靠 modify 改回原值；但前提是先记下原值。
        // 记在 modify 之后：modify 抛异常时尺寸没变（fixed 也不会加），记进来只会让
        // 回滚多"恢复"一处不存在的改动，把 fixedGivenBack 算大。
        recMod(viaObjId, { kind: 'via', before: { holeDiameter: curH, diameter: curD } });
        fixed++;
        log('viaShrunk', { via: viaObjId, from: [curH, curD], to: [11.8, 19.7] });`
]);

// ---------- P4：viaDeleted 记录（不可恢复，如实上报） ----------
H.push([
`        await eda.pcb_PrimitiveVia.delete(viaObjId);
        fixed++;
        log('viaDeleted', { via: viaObjId, d: curD, net: netName.trim() || '(unknown)' });`,
`        await eda.pcb_PrimitiveVia.delete(viaObjId);
        // 删除**没有逆操作**：create 生成的是新 id，等于换掉一个过孔，不算恢复。
        // 记下来的唯一用途是让整轮回滚如实报告"这条 via 回不来"，而不是像旧实现那样
        // 清单里根本没有它 → 日志说"已回滚" → 板上却少了一个过孔。
        recMod(viaObjId, { kind: 'viaDeleted', net: netName.trim(), before: { holeDiameter: curH, diameter: curD } });
        fixed++;
        log('viaDeleted', { via: viaObjId, d: curD, net: netName.trim() || '(unknown)' });`
]);

// ---------- P5：dogleg 回滚 ----------
H.push([
`        } catch (e4) {
          for (const id of madeHere.reverse()) {
            try { await eda.pcb_PrimitiveLine.delete(id); } catch (e5) { }
          }
          try { await eda.pcb_PrimitiveLine.modify(trackId, { endX: ex, endY: ey }); } catch (e6) { }
          log('trackDoglegRolledBack', { line: trackId, net,
            made: madeHere.length, m: String(e4 && e4.message).slice(0, 100) });
          continue;
        }`,
`        } catch (e4) {
          // 起因单独成键；回滚结果由 rollbackLineFix 逐项上报，不再混在一行里
          log('trackDoglegFixFail', { line: trackId, net,
            made: madeHere.length, m: String(e4 && e4.message).slice(0, 100) });
          await rollbackLineFix('dogleg', trackId, net, madeHere, ex, ey);
          continue;
        }`
]);

// ---------- P6：L 形绕行回滚 ----------
H.push([
`      } catch (e2) {
        // 第一段成功、第二段失败时，第一段会变成一条**悬空短线**：
        // 它不连到原终点，白占铜、还可能自己触发新的间距违规。
        for (const id of madeL.reverse()) {
          try { await eda.pcb_PrimitiveLine.delete(id); } catch (e7) { }
        }
        try { await eda.pcb_PrimitiveLine.modify(trackId, { endX: ex, endY: ey }); } catch (e3) { }
        log('trackRerouteRolledBack', { line: trackId, net, made: madeL.length,
          m: String(e2 && e2.message).slice(0, 100) });
        continue;
      }`,
`      } catch (e2) {
        // 第一段成功、第二段失败时，第一段会变成一条**悬空短线**：
        // 它不连到原终点，白占铜、还可能自己触发新的间距违规。
        // 起因单独成键；删/改的结果由 rollbackLineFix 逐项上报（n + ids）。
        log('trackRerouteFixFail', { line: trackId, net, made: madeL.length,
          m: String(e2 && e2.message).slice(0, 100) });
        await rollbackLineFix('L', trackId, net, madeL, ex, ey);
        continue;
      }`
]);

const bad = [];
H.forEach(([oldS], i) => {
  const n = s.split(oldS).length - 1;
  if (n !== 1) bad.push(`P${i + 1} 命中 ${n} 次（应为 1）`);
});
if (bad.length) {
  console.log('  FAIL 未写盘：');
  bad.forEach(b => console.log('    ' + b));
  process.exit(1);
}
for (const [oldS, newS] of H) s = s.replace(oldS, newS);

// 补丁后必须能作为 async 函数体解析
try { new (require('vm').Script)('(async()=>{' + s + '\n})', { filename: 'w.js' }); }
catch (e) { console.log('  FAIL 语法错误，未写盘：' + e.message); process.exit(1); }

// 吞异常模式必须归零，新辅助函数必须出现 2 次
const swallowed = ['catch (e5) { }', 'catch (e6) { }', 'catch (e7) { }', 'catch (e3) { }']
  .map(p => [p, s.split(p).length - 1]).filter(([, n]) => n > 0);
if (swallowed.length) { console.log('  FAIL 仍有吞异常：' + JSON.stringify(swallowed)); process.exit(1); }

const helperN = s.split('rollbackLineFix(').length - 1;
// 只数**真的日志调用**。旧键名会正当出现在 rollbackLineFix 的说明注释里
// （"旧实现写的是 trackDoglegRolledBack"），按裸字符串数会把自己写对的注释判成残留。
const oldKeyN = (s.split("log('trackDoglegRolledBack'").length - 1)
  + (s.split("log('trackRerouteRolledBack'").length - 1);
if (helperN !== 2) { console.log(`  FAIL rollbackLineFix 调用 ${helperN} 处（应为 2）`); process.exit(1); }
if (oldKeyN !== 0) { console.log(`  FAIL 旧日志键残留 ${oldKeyN} 处`); process.exit(1); }

// 原子写：先写同目录临时文件再 rename（NTFS 同卷 rename 是原子的）。
// 运行中的设计会在 invoke 开始时读 --code-file，若此刻直接截断重写，
// 它可能读到半截文件。rename 让"读到的永远是完整旧版或完整新版"。
const tmp = P + '.next';
fs.writeFileSync(tmp, s, 'utf8');
fs.renameSync(tmp, P);
console.log(`  写入成功 ${before} -> ${s.length} 字符（原子 rename）`);
console.log(`  校验：吞异常归零 ✓  rollbackLineFix 调用 ${helperN} 处  旧日志键残留 ${oldKeyN} 处`);
