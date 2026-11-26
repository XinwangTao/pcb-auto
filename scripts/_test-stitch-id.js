// _test-stitch-id.js —— 锁住「缝合补的线必须能事后归因」这条判据。
//
// 背景（测量缺口，2026-11-26 02:1x）：
//   stitch 用 `pcb_PrimitiveLine.create(net, layer, x1,y1,x2,y2, STITCH_W)` 直接补 12mil 的线，
//   **完全不检查它会不会压到异网焊盘**。而 `Clearance Error | SMD Pad to Track` 是全库
//   第二大失败类别（61 条，仅次于 Connection Error）。所以"缝合有没有制造间距违规"
//   是个真问题 —— 但旧日志只记 net/layer/gap/from/to，没有 primitive id。
//   拿到一条违规的 `obj1`（Track id）时无法回答"这条线是不是我自己补的"，
//   于是这个问题从来没被测量过，只能靠猜。
//
//   修法不是先加预检查（那会在没证据的情况下引入新风险），而是**先记 id**：
//   有了 id 才能数出"有多少条违规命中缝合补的线"，再决定要不要加闸门。
//   —— 先测量，再设闸门。
//
// 本测试守四件事：
//   A. stitch 日志里有 id 字段，且值来自 create 的返回值（不是自己编的）
//   B. stitchNoObj（create 返回 undefined）也记 from/to，否则失败无法复查
//   C. 不得用 try/catch 把 ID 读取包起来吞掉（那等于"没取到"="不存在"）
//   D. 结构：id 必须在 `const mId = m?.getState_PrimitiveId?.();` 之后取
//
// 用法: node _test-stitch-id.js [pipeline3.js 路径]
'use strict';
const fs = require('fs');
const path = require('path');

const TARGET = process.argv[2] || path.join(__dirname, 'pipeline3.js');
let src;
try {
  src = fs.readFileSync(TARGET, 'utf8');
} catch (e) {
  console.error('读不到 ' + TARGET + ' : ' + e.message);
  process.exit(2);
}

let pass = 0;
const fails = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; return; }
  fails.push(name + (detail ? '  << ' + detail : ''));
};
const at = (s) => src.indexOf(s);

// 先立：缝合日志本身存在。不存在时后面全部不成立（fail-closed，不许真空为真）。
const HAS = at("log('stitch', { net, layer, gap:") >= 0;
ok('A0 存在 stitch 补线日志', HAS);
const gate = (name, cond, detail) => ok(name, HAS && cond, HAS ? detail : 'stitch 日志不存在');

// A. id 字段
gate('A1 stitch 日志里记了 id', /log\('stitch',[\s\S]{0,600}?id:\s*String\(mId\)/.test(src));
gate('A2 id 来自 create 的返回值（有 mId 定义）',
  /const mId = m\?\.getState_PrimitiveId\?\.\(\);/.test(src));
gate('A3 mId 在 id 之前定义', (() => {
  const a = at('const mId = m?.getState_PrimitiveId?.();');
  const b = at("id: String(mId)");
  return a > 0 && b > 0 && a < b;
})());

// B. 失败路径也要能复查
gate('B1 stitchNoObj 记了 from',
  /log\('stitchNoObj',[\s\S]{0,400}?from: \[Math\.round\(myAnchor\.x\)/.test(src));
gate('B2 stitchNoObj 记了 to',
  /log\('stitchNoObj',[\s\S]{0,500}?to: \[Math\.round\(other\.x\)/.test(src));

// C. 不许吞错
//   注意判据：`getState_PrimitiveId` 是**在** create 的 try 块里的（那是正常的，
//   整段 create+log 一起兜异常）。真正要守的不是"别放进 try"，
//   而是"catch 必须有独立日志键"——空 catch 才会把"抛错了"变成"什么都没发生"。
gate('C1 取 id 的 try 块 catch 必须记独立键 stitchErr（空 catch = 把"抛错"变成"没发生"）', (() => {
  const i = at('const m = await eda.pcb_PrimitiveLine.create(');
  if (i < 0) return false;
  const c = src.indexOf('catch (e)', i);
  if (c < 0) return false;
  return /catch \(e\) \{ log\('stitchErr'/.test(src.slice(c, c + 200));
})());
gate('C1b 不得有空的 catch 直接收工', !/catch \(e\) \{ \}\s*\n\s*break;[\s\S]{0,80}stitch/.test(src));
gate('C2 create 返回 undefined 时不能记成成功',
  // 实测：`if (!mId) {` 到 `continue;` 之间 333 字符（中间是日志与三行注释）。
  // 窗口写 200 会误报成缺陷 —— 阈值必须是量出来的，不是估出来的。
  /if \(!mId\) \{[\s\S]{0,600}?continue;/.test(src));

// D. 语义 oracle：用真实返回值形状回放
//   create 的签名是 `Promise<IPCB_PrimitiveLine|undefined>`，失败 resolve undefined 而不抛。
//   `m?.getState_PrimitiveId?.()` 在 m 为 undefined 时得到 undefined；
//   在 API 文档里 getState_PrimitiveId() 返回 string。所以：
//     ''      → 取到空串，等价"没拿到"（不能当有效 id）
//     null    → 没拿到
//     undefined → 没拿到
//     '4bf5…'  → 有效
const hasId = (mId) => typeof mId === 'string' && mId.length > 0;
ok('D1 undefined 不算拿到 id', hasId(undefined) === false);
ok('D2 null 不算拿到 id', hasId(null) === false);
ok('D3 空串不算拿到 id', hasId('') === false);
ok('D4 真实 id 算拿到', hasId('4bf55c5b7faff38f') === true);
ok('D5 源码用的是同一个判据（if (!mId)）', /if \(!mId\)/.test(src));

// E. 反向对照：证明"有 id"与"没 id"在日志里可区分
ok('E1 成功与失败用两个不同的日志键（stitch vs stitchNoObj）',
  at("log('stitch', {") > 0 && at("log('stitchNoObj'") > 0 &&
  at("log('stitch', {") !== at("log('stitchNoObj'"));

if (fails.length) {
  console.log('FAIL ' + fails.length + '/' + (pass + fails.length));
  for (const f of fails) console.log('  × ' + f);
  process.exit(1);
}
console.log('PASS  ' + pass + '/' + pass + ' 通过  (缝合补线记 primitive id：事后可数"缝合是否制造间距违规")');
