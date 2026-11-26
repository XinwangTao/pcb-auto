// 结构锁：槽（Slot）必须在**布线之前**被罩成禁布区，且这一步不许把整板变成不可布区。
//
// 为什么值得锁：槽不是图元类型，它是 FILL@MULTI。布线引擎配置里没有 keepout 概念
// （IPCB_AutoRouteEngineConfig），所以布线器先天不知道槽在哪，只会在 DRC 事后被抓。
// 我们靠 IPCB_PrimitiveRegion.create(12, poly, [NO_WIRES, NO_POURS]) 提前罩住它。
// 这中间有三处一旦写错就是**灾难性**的（整板不可布 / 静默失效 / 无证据）：
//   ① 罩在 autoLayout 之前 → 布局会移动器件，禁布区留在原地，等于没罩
//   ② 没有面积上限     → 整板大小的填充被罩住，一个网络都布不出来
//   ③ 不记数             → 无法区分"没槽"、"罩失败"、"罩成功但引擎不认"
const fs = require('fs');
const path = require('path');

const target = process.argv[2] || path.join(__dirname, 'pipeline3.js');
const src = fs.readFileSync(target, 'utf8');
const lines = src.split('\n');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  << ' + detail : '')); }
};
const lineOf = (needle) => {
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(needle)) return i + 1;
  return -1;
};
const indentOf = (n) => {
  const l = lines[n - 1];
  if (l === undefined) return -1;
  return l.length - l.trimStart().length;
};

// A. 基本存在性
const Lget = lineOf('pcb_PrimitiveFill.getAllPrimitiveId(12)');
const Lcreate = lineOf('pcb_PrimitiveRegion.create(12, spoly');
const Llog = lineOf("log('slotKeepout', slotKeepout)");
check('A1 按 MULTI(12) 枚举填充', Lget > 0, 'L=' + Lget);
check('A2 用 region.create 罩在 MULTI 上', Lcreate > 0, 'L=' + Lcreate);
check('A3 结果落进日志', Llog > 0, 'L=' + Llog);

// B. 顺序：必须在 autoLayout 之后、preVia 之前（布局会移动器件，槽跟着动）
const Llayout = lineOf("phase('autoLayout')");
const LpreVia = lineOf("phase('preVia')");
const Lrouting = lineOf("phase('autoRouting')");
check('B1 autoLayout 阶段存在', Llayout > 0, 'L=' + Llayout);
check('B2 preVia 阶段存在', LpreVia > 0, 'L=' + LpreVia);
check('B3 autoRouting 阶段存在', Lrouting > 0, 'L=' + Lrouting);
check('B4 罩禁布区在 autoLayout 之后（否则布局移动器件后禁布区错位）',
  Lget > 0 && Llayout > 0 && Lget > Llayout, 'get=' + Lget + ' layout=' + Llayout);
check('B5 罩禁布区在 autoRouting 之前（否则布线器仍不知道槽在哪）',
  Lget > 0 && Lrouting > 0 && Lget < Lrouting, 'get=' + Lget + ' routing=' + Lrouting);
check('B6 罩禁布区在 preVia 之前（预打过孔也要避开槽）',
  Lget > 0 && LpreVia > 0 && Lget < LpreVia, 'get=' + Lget + ' preVia=' + LpreVia);

// C. ruleType 必须同时禁布线、禁覆铜；层必须是 MULTI
check('C1 ruleType 含 NO_WIRES(5) 与 NO_POURS(7)',
  Lcreate > 0 && /create\(\s*12\s*,\s*spoly\s*,\s*\[\s*5\s*,\s*7\s*\]/.test(src));

// D. 面积上限：必须在 create **之前**生效
const Lcap = lineOf('if (sArea > 640000) { slotKeepout.skippedBig++; continue; }');
check('D1 有面积上限且会跳过', Lcap > 0, 'L=' + Lcap);
check('D2 面积上限在 create 之前生效（顺序错了上限就没用）',
  Lcap > 0 && Lcreate > 0 && Lcap < Lcreate, 'cap=' + Lcap + ' create=' + Lcreate);
check('D3 被跳过的数量单独记（不能并进 failed）', Lcap > 0 && lines[Lcap - 1].includes('skippedBig'));

// E. fail-soft：取值与建区都必须被 try/catch 包住，否则一块怪封装能终止整次运行
const block = (() => {
  const s = lineOf('let slotKeepout = {');
  const e = lineOf("log('slotKeepout', slotKeepout)");
  return s > 0 && e > s ? lines.slice(s - 1, e).join('\n') : '';
})();
check('E1 能切出整段代码', block.length > 0);
check('E2 段内 create 处在 try 之内', /try\s*\{[\s\S]*pcb_PrimitiveRegion\.create/.test(block));
check('E3 最外层也有 try/catch 兜底', /^\}\s*catch\s*\(e\)\s*\{/m.test(block) && block.includes("log('slotKeepoutErr'"));
check('E4 失败与成功分开计数', block.includes('slotKeepout.failed++') && block.includes('slotKeepout.created++'));
check('E5 记了 areas（否则无法解释"为什么跳过"）', block.includes('slotKeepout.areas.push'));

// F. 不许出现"已加禁布区"这类没有数的自述
check('F1 日志里没有恒真的成功断言（必须带 found/created/failed 三个数）',
  block.includes('found: 0') && block.includes('created: 0') && block.includes('failed: 0'));

// G. 反向对照：去掉面积上限后，D1/D2 必须变红
const mut = src.replace('if (sArea > 640000) { slotKeepout.skippedBig++; continue; }', '');
check('G1 反向对照确实改动了源码', mut !== src);
check('G2 反向对照下 D1 判据变红', !mut.includes('if (sArea > 640000) { slotKeepout.skippedBig++; continue; }'));

// H. 反向对照：把真正的 create 调用删掉后，A2 判据必须变红。
//    这条专治"断言只匹配到注释"——注释里也有 pcb_PrimitiveRegion 字样，
//    所以必须删**代码行**而不是注释行，再确认判据确实失效。
const mut2 = src.replace(/^\s*const sr = await eda\.pcb_PrimitiveRegion\.create\(12, spoly.*$/m, '');
check('H1 反向对照2 确实改掉了代码行（源码变短）', mut2 !== src && mut2.length < src.length);
check('H2 反向对照2 下 A2 判据变红', !mut2.includes('pcb_PrimitiveRegion.create(12, spoly'));
// H3 反向对照：删掉枚举调用后 A1 判据必须变红
const mut3 = src.replace('pcb_PrimitiveFill.getAllPrimitiveId(12)', 'pcb_PrimitiveFill.getAllPrimitiveId()');
check('H3 反向对照3 下 A1 判据变红', !mut3.includes('pcb_PrimitiveFill.getAllPrimitiveId(12)'));

console.log('');
console.log((fail === 0 ? 'PASS' : 'FAIL') + '  ' + pass + '/' + (pass + fail) + ' 通过');
process.exit(fail === 0 ? 0 : 1);
