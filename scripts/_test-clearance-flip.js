// 结构锁：间距兜底平移必须**两侧都试**，不能只按"违规点在哪一侧"定死方向。
//
// 为什么值得锁：cur=0（走线压在障碍物上）时，(violX−mx, violY−my)·n ≈ 0，
// 侧别由浮点误差决定。朝障碍物那侧推，推多远都更近，必然搜不到安全位置，
// 于是被记成 clearanceSkipNoPush —— 把"方向选错"谎报成"几何不允许"。
// 实测 d12 USBC_Power_ESD-20261126-020219 的最后一处违规就是这条路径。
//
// 锁四件事：① 循环遍历两个方向；② 命中的方向被写回 side（否则后面的平移
// 仍用旧方向）；③ 换方向要留痕；④ 放弃时要标明"两侧都试过了"。
const fs = require('fs');
const path = require('path');

const target = process.argv[2] || path.join(__dirname, 'pipeline3.js');
const src = fs.readFileSync(target, 'utf8');
const lines = src.split('\n');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (d ? '  << ' + d : '')); } };
const lineOf = (needle, from) => { for (let i = (from || 0); i < lines.length; i++) if (lines[i].includes(needle)) return i + 1; return -1; };

// A. 两侧循环存在
const Lloop = lineOf('for (const sd of [side, -side]) {');
check('A1 存在「两个方向」的循环', Lloop > 0, 'L=' + Lloop);

// B. 循环体内用 sd 而不是 side 计算位移（写成 side 就等于仍是单侧）
const body = (() => {
  if (Lloop <= 0) return '';
  let depth = 0, out = [];
  for (let i = Lloop - 1; i < lines.length; i++) {
    out.push(lines[i]);
    depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
    if (depth === 0 && out.length > 1) break;
  }
  return out.join('\n');
})();
check('B1 能切出循环体', body.length > 0);
check('B2 位移用 sd（不是 side）', body.includes('nx * sd * p') && body.includes('ny * sd * p'));
check('B3 循环体内没有把 side 当位移因子', !/nx \* side \* p/.test(body));

// C. side 必须可写（let），且命中方向要写回
check('C1 side 用 let 声明（否则写回会抛 TypeError）', /let side = \(\(violX/.test(src) || /let side\s*=/.test(src));
const Lflip = lineOf("log('clearanceFlippedSide'");
check('C2 换方向有独立日志', Lflip > 0, 'L=' + Lflip);
check('C3 日志含 first/used/push 三个数', Lflip > 0 && lines.slice(Lflip - 1, Lflip + 4).join('\n').includes('used:') );
const Lassign = lineOf('side = pushSide;');
check('C4 命中方向写回 side', Lassign > 0, 'L=' + Lassign);
check('C5 写回发生在使用 side 算位移之前', Lassign > 0 && Lassign < lineOf('const ox = nx * side * push'));

// D. 放弃时必须标明两侧都试过
const Lskip = lineOf("log('clearanceSkipNoPush'");
check('D1 clearanceSkipNoPush 仍在', Lskip > 0, 'L=' + Lskip);
check('D2 放弃时记录 bothSidesTried', Lskip > 0 && lines.slice(Lskip - 1, Lskip + 6).join('\n').includes('bothSidesTried: true'));

// E. 反向对照：退回单侧后 A1/B2 判据必须变红
const mut = src.replace('for (const sd of [side, -side]) {', 'for (const sd of [side]) {');
check('E1 反向对照确实改动了源码', mut !== src);
check('E2 反向对照下 A1 判据变红', !mut.includes('for (const sd of [side, -side]) {'));
// 注意：String.replace 传**字符串**只替换第一处；位移表达式在循环里出现两次，
// 用字符串替换会留下第二处，判据仍命中 ⇒ 反向对照看起来"没生效"（我第一次就踩了）。
const mut2 = src.replace(/nx \* sd \* p/g, 'nx * side * p').replace(/ny \* sd \* p/g, 'ny * side * p');
check('E3 反向对照2 确实改动了源码（两处都替换）', mut2 !== src);
check('E4 反向对照2 下 B2 判据变红', !(mut2.includes('nx * sd * p') && mut2.includes('ny * sd * p')));

// F. 安全性没有被放宽：判据仍是 geoDistSeg >= NEED
check('F1 命中条件仍是真实几何距离 >= NEED', /geoDistSeg\(obs, sx \+ nx \* sd \* p/.test(src) && /\) >= NEED\)/.test(src));

console.log('');
console.log((fail === 0 ? 'PASS' : 'FAIL') + '  ' + pass + '/' + (pass + fail) + ' 通过');
process.exit(fail === 0 ? 0 : 1);
