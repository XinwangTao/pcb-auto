// 证明 pipeline3.js 里的 parseValue 真的按声明工作 —— 不是读代码猜，是把
// **补丁后的真实源码块**切出来在假 log/warns/errors 下跑。
// 覆盖缺陷 #6 的 4 个坑：M/m 塌陷、料号被读成数值、料号被洗成合法标称值、100nF≠0.1uF。
const fs = require('fs');
const vm = require('vm');
const P = process.argv[2];
const src = fs.readFileSync(P, 'utf8');

// 切出 parseValue + 比较链：起点必须包含包住它的 `if (item.value && real) {`，
// 否则切块会带着它那一侧的收尾大括号（净差 -1），new Function 直接语法错。
const a0 = src.indexOf('      const parseValue = (s) => {');
const a = a0 < 0 ? -1 : src.lastIndexOf('if (item.value && real) {', a0);
const b = src.indexOf('    r = await eda.sch_SourcePrimitiveComponent.add({');
if (a < 0 || b < 0 || b < a) { console.log('  FAIL 切不出比较块 a=' + a + ' b=' + b); process.exit(2); }
const block = src.slice(a, b).replace(/\s+$/, '');
if (!block.endsWith('}')) { console.log('  FAIL 切块结尾异常：' + JSON.stringify(block.slice(-30))); process.exit(2); }
{ let d = 0; for (const ch of block) { if (ch === '{') d++; else if (ch === '}') d--; }
  if (d !== 0) { console.log('  FAIL 切块花括号不平衡，净差 ' + d); process.exit(2); } }
if (/const NOM = /.test(block)) { console.log('  FAIL 切块里还有旧 NOM'); process.exit(2); }

// block 是一条完整语句：if (item.value && real) { ... }
const run = new Function('log', 'warns', 'errors', 'item', 'real', block + '\n;return { warns, errors };');

const T = [
  // [设计值, 器件实际值, 应判等价, 期望出现的日志键('' = 一条日志都不该有)]
  ['100nF', '0.1uF', true, ''], ['100nF', '100000pF', true, ''], ['0.1uF', '100000pF', true, ''],
  ['4R7', '4.7Ω', true, ''], ['1N5', '1.5nF', true, ''], ['8P', '8pF', true, ''],
  ['1K', '1k', true, ''], ['0R', '0Ω', true, ''], ['1k2', '1.2k', true, ''],
  ['10µF', '10uF', true, ''], ['5.1kΩ', '5.1K', true, ''],
  ['1N4148', '1N4148', true, ''], ['1N4148', '1N4148WS-7-F', true, ''],
  ['2N3904', '2N3904', true, ''],
  ['NC', '100nF', true, ''], ['DNP', '1k', true, ''], ['', '100nF', true, ''],
  // 必须报出来的
  ['10M', '10m', false, 'valueMismatch'],
  ['4.7k', '1kΩ', false, 'valueMismatch'],
  ['1N4148', '1N4007', false, 'valueCodeMismatch'],
  ['1N4148', '1.4148nF', false, 'valueKindMismatch'],
  ['2N3904', '2.2nF', false, 'valueKindMismatch'],
  ['104', '100nF', false, 'valueUncomparable'],
  ['1nF', '1nH', false, 'valueDimMismatch'],
  ['1.2.3', '1k', false, 'valueSyntax'],
  ['100nF', 'CL10B104KB8NNNC', false, 'valueKindMismatch'],
];

let pass = 0, fail = 0;
for (const [declared, actual, eq, wantKey] of T) {
  const logs = [], warns = [], errors = [];
  let out;
  try {
    out = run((k, v) => logs.push({ k, v }), warns, errors,
      { des: 'X1', lcsc: 'C1', value: declared }, actual);
  } catch (e) { console.log(`  FAIL 抛异常 ${declared} vs ${actual}: ${e.message}`); fail++; continue; }

  const keys = logs.map(l => l.k);
  let ok, why = '';
  if (eq) {
    ok = keys.length === 0 && out.errors.length === 0 && out.warns.length === 0;
    why = ok ? '' : `应静默等价，实际 keys=[${keys}] err=${out.errors.length}`;
  } else if (wantKey === 'valueMismatch') {
    ok = keys.includes('valueMismatch') && out.errors.length === 1 && out.warns.length === 1;
    why = ok ? '' : `应 valueMismatch + 1 err + 1 warn，实际 keys=[${keys}] err=${out.errors.length} warn=${out.warns.length}`;
  } else {
    ok = keys.includes(wantKey) && out.errors.length === 0;
    why = ok ? '' : `应 ${wantKey} 且 0 err，实际 keys=[${keys}] err=${out.errors.length}`;
  }
  if (ok) pass++; else { fail++; console.log(`  FAIL ${declared} vs ${actual}: ${why}`); }
}

console.log(`  ${pass}/${T.length} 通过  fail=${fail}`);
if (fail) process.exit(1);

// 关键负向：旧实现的两个真实后果必须已经不可能重现
const lg = [];
const e1 = [];
run((k, v) => lg.push(k), [], e1, { des: 'R1', lcsc: 'C11702', value: '4.7k' }, '1kΩ');
if (!lg.includes('valueMismatch') || e1.length !== 1) { console.log('  FAIL 真错料没被拦住'); process.exit(1); }
const lg2 = [];
const e2 = [];
run((k, v) => lg2.push(k), [], e2, { des: 'D1', lcsc: 'C1234', value: '1N4148' }, '1.4148nF');
if (lg2.includes('valueMismatch') || e2.length !== 0) { console.log('  FAIL 料号被当成数值硬比了'); process.exit(1); }
console.log('  负向：真错料仍拦住 ✓  料号不再被当数值 ✓');
