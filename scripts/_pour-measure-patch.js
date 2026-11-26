// _pour-measure-patch.js —— 只加「覆铜是否真的产出实铜」的测量，暂不动 computeOK()
//
// 为什么先测不加闸：
//   rebuildAllCopperRegions() 的 await 会在铜皮生成之前返回（README-drc.md 实测：
//   4 个失败里 2 个就是"重建没沉降完就判 DRC"）。所以"没抛异常"完全不等于"板上真有铜"。
//   全文件 13 处调用点里 11 处是纯空 catch、1 处只记常量 true，失败连痕迹都不留 ——
//   "历史上没报过 pourRebuildErr"只能推出"没被记录"，推不出"没失败过"。
//   直接加 gate 的风险是：判据一旦写错，会把现在能通过的 18 个设计全判成失败。
//   所以这一步只写字段、只加日志，把基线数据拿到，再决定闸门怎么写。
//
// 本脚本只生成候选文件 <target>.next，不碰正式文件；由 safe-edit.ps1 跑完闸门再原子替换。
'use strict';
const fs = require('fs');
const path = require('path');

const src = process.argv[2];
const dst = process.argv[3];
if (!src || !dst) { console.error('用法: node _pour-measure-patch.js <src> <dst>'); process.exit(2); }

let t = fs.readFileSync(src, 'utf8');
const before = t.length;
const applied = [];

function rep(label, from, to, expect) {
  const n = t.split(from).length - 1;
  const want = expect === undefined ? 1 : expect;
  if (n !== want) {
    console.error(`  ✗ ${label}: 命中 ${n} 次，期望 ${want} 次 —— 中止，未写任何文件`);
    process.exit(1);
  }
  t = t.split(from).join(to);
  applied.push(label);
  return n;
}

// ---------- 1. 声明（必须与 drcLeafCount 同层，否则 ReferenceError）----------
rep('声明 pourRebuildOk / pouredCount',
  `let drcTreeUsable = false;     // 这棵树到底有没有被我们读懂`,
  `let drcTreeUsable = false;     // 这棵树到底有没有被我们读懂
// 【覆铜是否真的产出实铜】rebuildAllCopperRegions 的 await 早于铜皮生成，所以
// "没抛异常"不等于"板上有铜"。三家离线脚本（verify-drc / audit-drc / README-drc）
// 的既有做法都是"重建 → 固定 sleep → 再 check"，说明这一点被反复踩过。
// 这里只**测量并留痕**，暂不进 computeOK —— 先拿基线，再决定闸门怎么写：
// 判据写错会把现在能通过的板子全判失败，比没有闸门更糟。
let pourRebuildOk = null;      // null=未测（预算跳过等）；true=实铜非空；false=确实试过但没铜
let pouredCount = null;        // pcb_PrimitivePoured.getAllPrimitiveId() 的真实条数`);

// ---------- 2. 判定前那次重建：空 catch → 测量 ----------
// 锚点用「rebuild + sleep(attempt...)」两行，唯一（其它 11 处没有 attempt 变量）
rep('判定前重建改为测量',
  `    try { await eda.pcb_PrimitivePour.rebuildAllCopperRegions(); } catch (e) { }
    await sleep(attempt === 0 ? 2500 : 1500);`,
  `    try {
      await eda.pcb_PrimitivePour.rebuildAllCopperRegions();
    } catch (e) {
      // 原来这里是纯空 catch：失败连日志都没有，"没报错"因此推不出"没失败"
      pourRebuildOk = false;
      log('pourRebuildErr', { attempt, m: String(e && e.message).slice(0, 200) });
    }
    await sleep(attempt === 0 ? 2500 : 1500);
    // 只在第 0 次测一次（多测要多付一次画布查询）；且必须在这段 sleep **之后**测，
    // 否则铜皮还没生成，量到的恒为 0 —— 那会把"没等够"误判成"覆铜坏了"。
    if (attempt === 0 && pourRebuildOk !== false) {
      try {
        const pouredIds = await eda.pcb_PrimitivePoured.getAllPrimitiveId();
        pouredCount = Array.isArray(pouredIds) ? pouredIds.length : null;
        // pourCount<=0 = 本次压根没建过覆铜区域，"覆铜产出"这项不适用，记 true
        pourRebuildOk = (pourCount <= 0) ? true : (pouredCount > 0);
        log('pourMeasured', { pourCount, pouredCount, ok: pourRebuildOk });
        if (pourRebuildOk !== true) log('pourRebuildEmpty', { pourCount, pouredCount });
      } catch (e) {
        log('pourMeasureErr', String(e && e.message).slice(0, 160));
      }
    }`);

// ---------- 3. 建覆铜后那次：常量 true → 真实条数 ----------
rep('建覆铜后记真实条数',
  `      await eda.pcb_PrimitivePour.rebuildAllCopperRegions();
      log('pourRebuilt', true);`,
  `      await eda.pcb_PrimitivePour.rebuildAllCopperRegions();
      // 原来记的是常量 true（"没抛就算成功"），永远证明不了任何事 —— 常量日志不是证据。
      await sleep(800);
      try {
        const ids0 = await eda.pcb_PrimitivePoured.getAllPrimitiveId();
        log('pourRebuilt', { poured: Array.isArray(ids0) ? ids0.length : null });
      } catch (e) {
        log('pourRebuilt', { poured: null, m: String(e && e.message).slice(0, 120) });
      }`);

// ---------- 4. gates 证据段 ----------
rep('gates 增加覆铜字段',
  `      artifacts: artifacts.length,`,
  `      artifacts: artifacts.length,
      // 覆铜产出：null = 未测（不能读成通过），false = 确实试过但没铜
      pourRebuildOk, pouredCount,`);

// ---------- 5. 返回值 ----------
rep('返回值增加覆铜字段',
  `  drcLeafCount,`,
  `  drcLeafCount,
  pourRebuildOk, pouredCount,`);

fs.writeFileSync(dst, t, 'utf8');
console.log('  已应用 ' + applied.length + ' 处：');
for (const a of applied) console.log('    ✓ ' + a);
console.log('  字节 ' + before + ' → ' + t.length + '  → ' + dst);
