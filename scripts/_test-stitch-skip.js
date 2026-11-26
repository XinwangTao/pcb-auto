// 结构锁：stitch 阶段的两处"静默放弃"必须被计数，并随 stitchRound 落进日志。
// 为什么值得单独立测试：这两个 continue 是**无声**的 —— 断点找不到锚点、最近邻岛
// 超过 MAX_GAP(150) 时直接跳过，既不算失败也不算跳过。过去无法回答
// "stitch 到底跳过了多少处"，于是"缝合没帮上忙"和"缝合压根没试"在文件层面一样。
//
// 判据必须是**可证伪的**：本测试自带反向对照 —— 把计数语句从源码里删掉后，
// 同一组断言必须变红。否则它只是一串恒真的字符串匹配（空真断言）。
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
// 某行的前导空格数（缩进必须实测，不能按猜）
const indentOf = (n) => {
  const l = lines[n - 1];
  if (l === undefined) return -1;
  return l.length - l.trimStart().length;
};

// A. 计数器声明存在，且在"每轮"作用域（4 空格），不是全局
const Ldecl = lineOf('let skipNoAnchor = 0, skipTooFar = 0;');
check('A1 计数器已声明', Ldecl > 0, 'L=' + Ldecl);
check('A2 声明在每轮作用域（前导 4 空格）', Ldecl > 0 && indentOf(Ldecl) === 4, 'indent=' + (Ldecl > 0 ? indentOf(Ldecl) : 'n/a'));

// B. 两处 continue 都计数了，且保持 8 空格缩进（在 layer 循环里）
const LnoAnchor = lineOf('if (myIsland < 0 || myD > 12) { skipNoAnchor++; continue; }');
const LtooFar = lineOf('if (!other || otherD > MAX_GAP) { if (other) skipTooFar++; else skipNoAnchor++; continue; }');
check('B1 「找不到锚点」分支已计数', LnoAnchor > 0, 'L=' + LnoAnchor);
check('B2 「超过 MAX_GAP」分支已计数', LtooFar > 0, 'L=' + LtooFar);
check('B3 两处仍在 layer 循环内（前导 8 空格）',
  LnoAnchor > 0 && LtooFar > 0 && indentOf(LnoAnchor) === 8 && indentOf(LtooFar) === 8,
  'indent=' + (LnoAnchor > 0 ? indentOf(LnoAnchor) : 'n/a') + '/' + (LtooFar > 0 ? indentOf(LtooFar) : 'n/a'));
check('B4 「无 other」与「other 太远」必须分开表达（否则把两种原因混成一类）',
  LtooFar > 0 && lines[LtooFar - 1].includes('if (other) skipTooFar++; else skipNoAnchor++;'));

// C. 计数器必须落进日志，否则等于没测
const Llog = lineOf('skippedNoAnchor: skipNoAnchor');
check('C1 stitchRound 已带 skippedNoAnchor', Llog > 0, 'L=' + Llog);
const Lround = lines.findIndex(l => l.includes("log('stitchRound'"));
check('C2 两个字段与 stitchRound 在同一条日志里',
  Lround >= 0 && lines[Lround].includes('skippedNoAnchor: skipNoAnchor') && lines[Lround].includes('skippedTooFar: skipTooFar'));

// D. 声明必须在使用之前（否则 TDZ 报错，且只有在缝合并未触发时才看不出来）
check('D1 声明行在两处使用之前', Ldecl > 0 && LnoAnchor > 0 && LtooFar > 0 && Ldecl < LnoAnchor && Ldecl < LtooFar,
  'decl=' + Ldecl + ' use=' + LnoAnchor + '/' + LtooFar);

// E. 反向对照：把计数语句删掉后，B1/B2 的断言必须失败。
//    这证明上面的断言不是"无论如何都通过"。
const mutated = src
  .replace('if (myIsland < 0 || myD > 12) { skipNoAnchor++; continue; }', 'if (myIsland < 0 || myD > 12) continue;')
  .replace('if (!other || otherD > MAX_GAP) { if (other) skipTooFar++; else skipNoAnchor++; continue; }', 'if (!other || otherD > MAX_GAP) continue;');
check('E1 反向对照确实改动了源码（两处都替换成功）', mutated !== src && mutated.length < src.length);
check('E2 反向对照下 B1 判据会变红', !mutated.includes('if (myIsland < 0 || myD > 12) { skipNoAnchor++; continue; }'));
check('E3 反向对照下 B2 判据会变红', !mutated.includes('if (!other || otherD > MAX_GAP) { if (other) skipTooFar++; else skipNoAnchor++; continue; }'));

// F. MAX_GAP 常量必须仍存在且被引用（防止计数语句把判据本身改坏）
check('F1 MAX_GAP 常量仍在', /const MAX_GAP = \d+;/.test(src));
check('F2 MAX_GAP 仍在上限判断里被引用', LtooFar > 0 && lines[LtooFar - 1].includes('otherD > MAX_GAP'));

console.log('');
console.log((fail === 0 ? 'PASS' : 'FAIL') + '  ' + pass + '/' + (pass + fail) + ' 通过');
process.exit(fail === 0 ? 0 : 1);
