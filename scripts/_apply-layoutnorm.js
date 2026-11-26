// 原子应用 patch-tx-layout-norm 的 2 个 hunk（缺陷 #5 autoLayout 取消 / #6 norm 归一化）。
// OLD 不手抄：从目标文件按行号切出来，再用锚点行校验切对了，
// 避免 33 行中文注释里一个字抄错就整块匹配不上。
const fs = require('fs');
const P = process.argv[2];
const DIR = require('path').dirname(P);
let s = fs.readFileSync(P, 'utf8');
const before = s.length;

const lines = s.split('\n');
const slice = (a, b) => lines.slice(a - 1, b).join('\n');   // 1-based，含两端

const H = [];

// ---------- #6：norm/NOM -> parseValue（L375..L407） ----------
const old6 = slice(375, 407);
if (!old6.startsWith('    // 只在**真的不同**时告警。')) {
  console.log('  FAIL #6 起始锚点不对：' + JSON.stringify(old6.slice(0, 40))); process.exit(1);
}
if (!old6.endsWith('      }\n    }')) {
  console.log('  FAIL #6 结束锚点不对：' + JSON.stringify(old6.slice(-40))); process.exit(1);
}
if (!/const NOM = /.test(old6) || !/const norm = \(s\)/.test(old6)) {
  console.log('  FAIL #6 切片里没有 norm/NOM'); process.exit(1);
}
H.push([old6, fs.readFileSync(DIR + '\\_new6.txt', 'utf8').replace(/\n$/, '')]);

// ---------- #5：autoLayout 超时不取消（L582..L591） ----------
const old5 = slice(582, 591);
if (!old5.startsWith('let layoutState = null;\ntry {')) {
  console.log('  FAIL #5 起始锚点不对：' + JSON.stringify(old5.slice(0, 40))); process.exit(1);
}
if (!old5.endsWith("} catch (e) { errors.push('autoLayout: ' + (e && e.message)); }")) {
  console.log('  FAIL #5 结束锚点不对：' + JSON.stringify(old5.slice(-60))); process.exit(1);
}
if (!/startAutoLayout/.test(old5) || /cancelAutoJob/.test(old5)) {
  console.log('  FAIL #5 切片内容不符（应含 startAutoLayout 且尚无 cancelAutoJob）'); process.exit(1);
}
H.push([old5, fs.readFileSync(DIR + '\\_new5.txt', 'utf8').replace(/\n$/, '')]);

// 唯一性
const bad = [];
H.forEach(([oldS], i) => {
  const n = s.split(oldS).length - 1;
  if (n !== 1) bad.push(`#${i === 0 ? 6 : 5} 命中 ${n} 次（应为 1）`);
});
if (bad.length) { console.log('  FAIL 未写盘：' + bad.join('；')); process.exit(1); }

for (const [oldS, newS] of H) s = s.replace(oldS, newS);

// 补丁后必须能作为 async 函数体解析
try { new (require('vm').Script)('(async()=>{' + s + '\n})', { filename: 'w.js' }); }
catch (e) { console.log('  FAIL 语法错误，未写盘：' + e.message); process.exit(1); }

// 语义守卫：旧实现的特征必须消失，新实现的特征必须出现
const must = [
  ['取消布局', /cancelAutoJob\(job\.jobId\)/],
  ['layoutState 不被取消改成 completed（只有作业自报 completed 时才改）',
    /if \(rc\.state === 'completed' && rc\.st\?\.partial !== true\) \{\n\s*layoutState = 'completed';/],
  ['parseValue', /const parseValue = \(s\) => \{/],
  ['JEDEC 料号优先', /\^\[1-3\]\[Nn\]\\d\{2,\}/],
  ['量纲归类', /const dim = base === 'F'/],
];
const gone = [
  ['旧的 NOM 白名单', /const NOM = /],
  ['旧的 norm', /const norm = \(s\) =>/],
  ['旧的料号误读规则', /t\.replace\(\/\^\\d\+\(\[RKMNPV\]\)/],
];
const bad2 = [];
for (const [name, re] of must) if (!re.test(s)) bad2.push('缺少 ' + name);
for (const [name, re] of gone) if (re.test(s)) bad2.push('残留 ' + name);
if (bad2.length) { console.log('  FAIL 未写盘：' + bad2.join('；')); process.exit(1); }

const tmp = P + '.next';
fs.writeFileSync(tmp, s, 'utf8');
fs.renameSync(tmp, P);
console.log(`  写入成功 ${before} -> ${s.length} 字符（原子 rename）`);
console.log('  守卫：' + must.map(([n]) => n).join(' / ') + ' 均就位；旧 norm/NOM/料号误读规则已清零');
