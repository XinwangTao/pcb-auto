// 手工探针（不在 package.json 的 7 闸门链里）：证明 pipeline3.js 的 parseValue
// 真的把「人写的带单位值」归一化成可比的 (kind, 量纲 dim, 数值 v)，而不是读代码猜。
// 本仓库踩过的真坑：2.2nF 被写成 2.2pF，差 1000 倍 —— 必须判不等。
//
// 跑法：node scripts\_test-value-norm.js              # 默认测同目录的 pipeline3.js
//       node scripts\_test-value-norm.js <路径>       # 测指定文件
// 退出码：0 全部断言通过 / 1 有用例判错 / 2 探针自己切不出被测代码（量具坏了）
const fs = require('fs');
const path = require('path');

const P = process.argv[2] || path.join(__dirname, 'pipeline3.js');
if (!fs.existsSync(P)) { console.log('  FAIL 找不到被测文件：' + P); process.exit(2); }
const src = fs.readFileSync(P, 'utf8');

function dead(msg) { console.log('  FAIL ' + msg); process.exit(2); }

// 从 open（必须是 '{'）数到配对的 '}'。被测代码里的模板字面量 ${...} 自平衡，够用。
function braceEnd(s, open) {
  let d = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') d++;
    else if (s[i] === '}' && --d === 0) return i;
  }
  return -1;
}

let pass = 0, fail = 0;

const closeTo = (a, b, rel) => typeof a === 'number' && typeof b === 'number'
  && isFinite(a) && isFinite(b) && (a === b || Math.abs(a - b) <= Math.abs(b) * (rel || 1e-9));

/* ── 1. 直接切出 parseValue 本体：查 kind / 量纲 / 归一化后的数值 ── */
const pvM = /const\s+parseValue\s*=\s*\(s\)\s*=>\s*\{/.exec(src);
if (!pvM) dead('切不出 parseValue 定义（pipeline3.js 改形了？）');
const pvOpen = pvM.index + pvM[0].length - 1;
const pvEnd = braceEnd(src, pvOpen);
if (pvEnd < 0) dead('parseValue 函数体花括号不平衡');
let parseValue;
try {
  const arrow = src.slice(pvM.index + pvM[0].indexOf('(s)'), pvEnd + 1);
  parseValue = new Function('return (' + arrow + '\n)')();
} catch (e) { dead('parseValue 本体编译失败：' + e.message); }
if (typeof parseValue !== 'function') dead('切出来的 parseValue 不是函数');

// [输入, 期望 kind, 期望 dim（null = 不查）, 期望归一化后的 v（null = 不查）]
const N = [
  ['2.2nF', 'num', 'C', 2.2e-9],
  ['2.2pF', 'num', 'C', 2.2e-12],
  ['100nF', 'num', 'C', 1e-7],
  ['0.1uF', 'num', 'C', 1e-7],
  ['100000pF', 'num', 'C', 1e-7],
  ['4.7k', 'num', 'R', 4700],
  ['4R7', 'num', 'R', 4.7],
  ['10M', 'num', 'R', 1e7],
  ['10m', 'num', 'R', 1e-2],
  ['1N4148', 'code', null, null],
  ['NC', 'marker', null, null],
  ['1.2.3', 'bad', null, null],
  ['', 'empty', null, null],
];
for (const [s, kind, dim, v] of N) {
  let r;
  try { r = parseValue(s); }
  catch (e) { fail++; console.log(`  FAIL parseValue(${JSON.stringify(s)}) 抛异常：${e.message}`); continue; }
  if (r && r.kind === kind && (dim == null || r.dim === dim) && (v == null || closeTo(r.v, v))) pass++;
  else {
    fail++;
    console.log(`  FAIL parseValue(${JSON.stringify(s)}) → ${JSON.stringify(r)}；` +
      `期望 kind=${kind} dim=${dim == null ? '-' : dim} v=${v == null ? '-' : v}`);
  }
}

// 核心回归：同一量纲、写法只差 SI 前缀 → 归一化后必须差 1000 倍。
{
  const a = parseValue('2.2nF'), b = parseValue('2.2pF');
  if (a && b && a.dim === b.dim && closeTo(a.v / b.v, 1000)) pass++;
  else {
    fail++;
    console.log(`  FAIL 2.2nF 与 2.2pF 归一化后应同量纲且差 1000 倍，实际 ${JSON.stringify(a)} / ${JSON.stringify(b)}`);
  }
}
// 旧实现整体 toUpperCase 会让 10M(兆) == 10m(毫)：必须差 10^9 倍。
{
  const a = parseValue('10M'), b = parseValue('10m');
  if (a && b && a.dim === b.dim && closeTo(a.v / b.v, 1e9)) pass++;
  else {
    fail++;
    console.log(`  FAIL 10M 与 10m 归一化后应差 10^9 倍（兆 vs 毫），实际 ${JSON.stringify(a)} / ${JSON.stringify(b)}`);
  }
}

/* ── 2. 切出整段比较链 if (item.value && real) { ... }，在假 log/warns/errors 下跑 ── */
// 起点必须包含包住 parseValue 的 `if (item.value && real) {`，否则切块会带着它那一侧
// 的收尾大括号（净差 -1），new Function 直接语法错。
const ifRe = /if\s*\(\s*item\.value\s*&&\s*real\s*\)\s*\{/g;
let from = -1;
for (let m; (m = ifRe.exec(src));) if (m.index < pvM.index) from = m.index;
if (from < 0) dead('切不出包住 parseValue 的 if (item.value && real) {');
const addRe = /r\s*=\s*await\s+eda\.sch_SourcePrimitiveComponent\.add\s*\(\s*\{/g;
let to = -1;
for (let m; (m = addRe.exec(src));) { if (m.index > from) { to = m.index; break; } }
if (to <= from) dead('切不出比较块结尾（找不到 add({ 那一行）');

const block = src.slice(from, to).replace(/\s+$/, '');
if (!block.endsWith('}')) dead('切块结尾异常：' + JSON.stringify(block.slice(-30)));
if (braceEnd(block, block.indexOf('{')) !== block.length - 1) dead('切块花括号不平衡');
if (/const\s+NOM\s*=/.test(block)) dead('切块里还有旧 NOM');

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
  // 2.2nF 这组是真实事故的形状：同量纲，只差前缀，必须判不等
  ['2.2nF', '2.2nF', true, ''], ['2n2', '2.2nF', true, ''], ['2.2nF', '2200pF', true, ''],
  // 必须报出来的
  ['10M', '10m', false, 'valueMismatch'],
  ['4.7k', '1kΩ', false, 'valueMismatch'],
  ['2.2nF', '2.2pF', false, 'valueMismatch'],
  ['1N4148', '1N4007', false, 'valueCodeMismatch'],
  ['1N4148', '1.4148nF', false, 'valueKindMismatch'],
  ['2N3904', '2.2nF', false, 'valueKindMismatch'],
  ['104', '100nF', false, 'valueUncomparable'],
  ['1nF', '1nH', false, 'valueDimMismatch'],
  ['1.2.3', '1k', false, 'valueSyntax'],
  ['100nF', 'CL10B104KB8NNNC', false, 'valueKindMismatch'],
];

const pos = T.filter((t) => t[2]).length, neg = T.length - pos;
if (pos < 3 || neg < 2) dead(`用例不足：正向 ${pos} / 反向 ${neg}（要求 ≥3 正向、≥2 反向）`);
// 只查这对用例在不在。把它的期望改错是"证明量具会红"的合法操作，不许被这条守卫拦掉。
if (!T.some((t) => t[0] === '2.2nF' && t[1] === '2.2pF')) dead('缺少 2.2nF vs 2.2pF 这条回归用例');

for (const [declared, actual, eq, wantKey] of T) {
  const logs = [], warns = [], errors = [];
  let out;
  try {
    out = run((k, v) => logs.push({ k, v }), warns, errors,
      { des: 'X1', lcsc: 'C1', value: declared }, actual);
  } catch (e) { fail++; console.log(`  FAIL 抛异常 ${declared} vs ${actual}: ${e.message}`); continue; }

  const keys = logs.map((l) => l.k);
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

const total = pass + fail;
console.log(`  直调 parseValue ${N.length + 2} 条 / 比较链 ${T.length} 条（正向 ${pos} / 反向 ${neg}）`);
if (fail) {
  console.log(`  FAIL  value-norm  ${pass}/${total} 条断言通过  fail=${fail}`);
  process.exit(1);
}
console.log(`  PASS  value-norm  ${pass}/${total} 条断言通过  被测：${P}`);
