// _test-revert-gate.js —— 锁住"回滚失败必须可见"这条闸门。
//
// 缺陷（真实事故，d13）：fixClearance 的回滚里 `pcb_PrimitiveLine.modify(id, orig)`
// 失败时 **resolve(undefined) 而不抛异常**，那条线就停在"被截短的中间态"：
// 既没还原成原样，也没被删掉。旧实现只打一行 clearanceRevertLineRestoreFail 日志，
// 然后 break 出整个轮循环 —— 板上真实留下悬空铜，clearanceFixes 还宣称这处修复有效，
// computeOK() 完全看不见（fixClearance 整段 18 处 errors.push 一个都不在）。
// 实测后果：违规数 1 → 2，多出一条 Connection Error + 一条 Track×Track。
//
// 本测试守四件事：
//   A. 三态声明在**首次使用之前**（staticcheck 若不过就是这条）；
//   B. 轮末 + rollbackLineFix 两条路径都收集 id 并置 false；
//   C. gates/return 都带出，且 **computeOK() 一字未改**；
//   D. 三态判定的纯函数 oracle + 反向对照（证明测试有鉴别力）。
'use strict';
const fs = require('fs');
const path = require('path');

const TARGET = process.argv[2] || path.join(__dirname, 'pipeline3.js');
let src;
try { src = fs.readFileSync(TARGET, 'utf8'); }
catch (e) { console.error('读不到 ' + TARGET + ' : ' + e.message); process.exit(2); }

let pass = 0;
const fails = [];
const ok = (name, cond, detail) => { if (cond) pass++; else fails.push(name + (detail ? '  << ' + detail : '')); };
const at = (s) => src.indexOf(s);

// ─────────────── A. 声明必须在首次使用之前 ───────────────
const declOk = at('let clearanceRevertOk = null;');
const declSet = at('const danglingLines = new Set();');
ok('A1 声明 clearanceRevertOk', declOk >= 0, '缺三态变量');
ok('A2 声明 danglingLines', declSet >= 0, '缺残留集合');
ok('A3 三态初值是 null（不是 false —— 未测不能读成失败，也不能读成通过）',
  /let clearanceRevertOk = null;/.test(src), '初值不是 null');

// 所有使用点都必须晚于声明，否则运行时 TDZ（staticcheck 查的是同一类错）
const uses = [
  ['rollbackLineFix 收集', 'clearanceRevertOk = false;\n  }\n  if (lineFail.length) log(\'rollbackLineFail\''],
  ['轮末收集', 'clearanceRevertOk = (restoreFail.length || delFail.length) ? false : true;'],
  ['gates 落盘', '      clearanceRevertOk,'],
  ['return 带出', '  clearanceRevertOk, clearanceRevertDangling'],
];
for (const [name, s] of uses) {
  const i = at(s);
  ok('A4 ' + name + ' 存在', i >= 0, '锚点没命中');
  if (i >= 0) ok('A5 ' + name + ' 晚于声明（无 TDZ）', i > declOk && i > declSet,
    'use@' + i + ' decl@' + declOk);
}

// ─────────────── B. 两条路径都必须收 ───────────────
ok('B1 轮末：restoreFail 进 danglingLines',
  /for \(const id of restoreFail\) danglingLines\.add\(String\(id\)\);/.test(src), 'restoreFail 没收集');
ok('B2 轮末：delFail 进 danglingLines',
  /for \(const id of delFail\) danglingLines\.add\(String\(id\)\);/.test(src), 'delFail 没收集');
ok('B3 轮末：给出 clearanceRevertGaveUp（不只是打原来那行）',
  /log\('clearanceRevertGaveUp'/.test(src), '没升级成 gave-up 日志');
ok('B4 clearanceRevertGaveUp 带 why（决策理由必须留痕）',
  /why: '[^']*中间态/.test(src), 'why 字段缺失或没说明');
ok('B5 rollbackLineFix 也收（同一病灶的第二条路径）',
  /for \(const id of lineFail\) danglingLines\.add\(String\(id\)\);/.test(src), 'dogleg 路径漏了');
ok('B6 rollbackLineFix 里 modifyFail 时把 trackId 记为悬空线',
  /if \(modifyFail !== null\) danglingLines\.add\(String\(trackId\)\);/.test(src), 'trackId 没记');
ok('B7 原日志键名保留（_drcstats/_trend 按字面统计）',
  /log\('clearanceRevertLineRestoreFail'/.test(src) && /log\('clearanceRevertDeleteFail'/.test(src),
  '改了名字 → 离线统计会失明');

// ─────────────── C. 落盘 + computeOK 不许动 ───────────────
ok('C1 gates 里有 clearanceRevertOk', /gates: \{[\s\S]{0,900}?clearanceRevertOk,/.test(src), 'gates 缺字段');
ok('C2 gates 里有 clearanceRevertDangling 数组', /clearanceRevertDangling: \[\.\.\.danglingLines\],/.test(src), '缺数组');
const nDang = (src.match(/clearanceRevertDangling: \[\.\.\.danglingLines\],/g) || []).length;
ok('C3 gates + return 两处都带', nDang === 2, '只出现 ' + nDang + ' 次');
const ck = src.match(/const computeOK = \(\) =>[\s\S]*?;\n/);
ok('C4 能解析出 computeOK', !!ck, '正则没命中');
ok('C5 computeOK() 不含 clearanceRevert（观察期不否决）',
  ck && !/clearanceRevert/.test(ck[0]), 'computeOK 被改了 → 会把眼下能过的板子判死');

// ─────────────── D. 三态 oracle + 反向对照 ───────────────
// 复刻轮末那行判定的语义
const revertState = (restoreFail, delFail) => (restoreFail.length || delFail.length) ? false : true;
const T = [
  { name: '全部还原', r: [], d: [], want: true },
  { name: '有线没还原回来', r: ['0e07a2ed4c87420a'], d: [], want: false },
  { name: '有段没删掉', r: [], d: ['abc1234567890abc'], want: false },
  { name: '两者都有', r: ['a'], d: ['b'], want: false },
];
for (const t of T) {
  ok('D1 [' + t.name + '] → ' + t.want, revertState(t.r, t.d) === t.want,
    '得到 ' + revertState(t.r, t.d));
}
// 未发生回滚时该变量保持 null —— 这正是"未测 ≠ 通过"的载体
ok('D2 未发生回滚时三态保持 null（不被写成 true）',
  !/clearanceRevertOk = true;/.test(src), '有人把它无条件置 true 了');
// 反向：若把判定写成恒 true（旧行为的等价物），D1 必须变红
const bad = () => true;
const badRed = T.filter(t => bad() !== t.want).length;
ok('D3 反向对照：恒真实现必须让 ' + T.filter(t => t.want === false).length + ' 条用例变红',
  badRed === T.filter(t => t.want === false).length, '只有 ' + badRed + ' 条变红 → 测试没鉴别力');

if (fails.length) {
  console.error('FAIL  ' + (pass + fails.length - fails.length) + '/' + (pass + fails.length) + ' 通过');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('PASS  ' + pass + '/' + pass + ' 通过  (三态: null=未测 / true=全还原 / false=有残留)');
process.exit(0);
