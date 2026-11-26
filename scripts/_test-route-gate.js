// _test-route-gate.js —— 锁住 autoRouting 的预算闸判据。
//
// 背景（真实事故）：RP2040_QSPI_Flash 同一块 1411x1411 板跑了 5 次，4 次成功全部是
// iter 3（COMPLETION 保底轮）把 stillUnconnected 打到 0，每次只花 21~31 秒。
// 唯独 214200 那次 left()=275030，capRaw=95030 < 120000，四轮全被跳过
// （routeAttempts=[]，stillUnconnected 停在 41），最终 52 条 DRC 叶子，
// 而收尾时还白剩 160 秒。那块板本来能布通 —— 门槛按错了量级。
//
// 本测试守三件事：
//   A. 结构：闸门读 capNeed（按 isStrong 分流），且旧的一刀切常数**确实不见了**；
//   B. 算术：用 5 次真实 left() 回放，断言 214200 那次保底轮放行、
//            且常规轮在同一预算下**仍然跳过**（不能顺手把 FAST 也放出去）；
//   C. 反向：把 capNeed 退回旧值，214200 必须变回"跳过"——否则本测试没有鉴别力。
//
// 用法: node _test-route-gate.js [pipeline3.js 路径]
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
const has = (s) => src.indexOf(s) >= 0;

// ───────────────────────── A. 结构锁 ─────────────────────────
ok('A1 声明 capNeed 并按 isStrong 分流',
  has("const capNeed = isStrong ? 45000 : 120000;"),
  '缺 capNeed 分流');

ok('A2 判据用 capNeed',
  has("if (capRaw < capNeed) {"),
  '判据没换成 capNeed');

ok('A3 旧的一刀切常数已消失',
  !has("if (capRaw < 120000) {"),
  '旧的 if (capRaw < 120000) 还在');

ok('A4 capRaw 仍由 left() 减 180000 得到（收尾预留没被动过）',
  has("const capRaw = left() - 180000;"),
  'capRaw 算法被改了');

ok('A5 等待时长仍被 capRaw 兜住（不会超 invoke 超时）',
  has("Math.min(isFirstTry ? 900000 : 600000, capRaw)"),
  'waitJob 的 capRaw 上限没了');

ok('A6 跳闸日志带上了 capRaw/capNeed（下次不用离线算术回放）',
  has("log('routeBudgetSkip', { iter, variant: v.name, leftMs: left(), capRaw, capNeed, isStrong });"),
  'routeBudgetSkip 仍只记 leftMs');

// 常量从源码里真读出来，而不是硬编码一份 —— 否则改了源码测试照样绿
const mNeed = src.match(/const capNeed = isStrong \? (\d+) : (\d+);/);
ok('A7 能解析出 capNeed 两个常数', !!mNeed, '正则没命中');
const NEED_STRONG = mNeed ? Number(mNeed[1]) : NaN;
const NEED_FAST = mNeed ? Number(mNeed[2]) : NaN;

ok('A8 保底轮门槛严格低于常规轮（这才是本次修复的语义）',
  Number.isFinite(NEED_STRONG) && Number.isFinite(NEED_FAST) && NEED_STRONG < NEED_FAST,
  'strong=' + NEED_STRONG + ' fast=' + NEED_FAST);

ok('A9 保底轮门槛覆盖实测 21~31s 且有余量（45s ∈ [31s, 120s)）',
  NEED_STRONG >= 31000 && NEED_STRONG < NEED_FAST,
  'strong=' + NEED_STRONG);

// ──────────────────── B. 算术回放（真实 left()） ────────────────────
// 数据来源：logs\RP2040_QSPI_Flash-*.json 的 budget.totalMs 与 autoRouting 相位 ms。
// 同一块 1411x1411 板，只有 left() 不同。
const TAIL_RESERVE = 180000;
const CASES = [
  // left(), 最终 DRC 叶子数, 该次是否布通
  { left: 399926, leaves: 2, via: '215630' },
  { left: 400215, leaves: 0, via: '220801' },
  { left: 497339, leaves: 0, via: '232022' },
  { left: 275030, leaves: 52, via: '214200' },
];

const gate = (left, isStrong) => {
  const capRaw = left - TAIL_RESERVE;
  return { capRaw, runs: !(capRaw < (isStrong ? NEED_STRONG : NEED_FAST)) };
};

for (const c of CASES) {
  const strong = gate(c.left, true);
  const fast = gate(c.left, false);
  // 保底轮：每一次都必须在预算上放行（4 次里有 3 次正是它把断连清零的）
  ok('B1[' + c.via + '] 保底轮 left=' + c.left + ' capRaw=' + strong.capRaw + ' 放行',
    strong.runs === true,
    '被跳过 → 这块板会重演 52 条叶子');
  // 常规轮：预算充足时同样放行（不能因为这次修复把常规轮改死）
  if (c.left - TAIL_RESERVE >= NEED_FAST) {
    ok('B2[' + c.via + '] 常规轮 left=' + c.left + ' 放行', fast.runs === true, '常规轮被误杀');
  }
}

// 关键一条：214200 那次 left()，保底轮放行但常规轮仍跳过。
// 只放宽保底轮、不顺手放出 FAST，是本次改动"安全"的全部理由。
const c214200 = CASES.find(c => c.via === '214200');
const s2 = gate(c214200.left, true);
const f2 = gate(c214200.left, false);
ok('B3 214200: 保底轮放行（capRaw=' + s2.capRaw + ' ≥ ' + NEED_STRONG + '）',
  s2.runs === true);
ok('B4 214200: 常规轮仍跳过（capRaw=' + f2.capRaw + ' < ' + NEED_FAST + '）',
  f2.runs === false,
  'FAST 也被放出去了 → 会 TIMEOUT 白烧时间，本次改动就不安全了');

// 真实收尾耗时（369923 − 254970 = 114953ms）：放行保底轮后必须仍有富余
const TAIL_REAL = 114953;
const worstCase = c214200.left - 31000; // 保底轮实测最长 31s
ok('B5 214200: 跑完保底轮后仍够收尾（' + worstCase + ' ≥ ' + TAIL_REAL + '）',
  worstCase >= TAIL_REAL,
  '余量 ' + (worstCase - TAIL_REAL) + 'ms');

// ──────────────────── C. 反向对照（鉴别力） ────────────────────
const OLD_NEED = 120000;
const oldRuns = !(c214200.left - TAIL_RESERVE < OLD_NEED);
ok('C1 退回旧常数后 214200 保底轮必须被跳过（证明 B1 有鉴别力）',
  oldRuns === false,
  '旧常数下也放行 → 说明 B1 恒真，测不出东西');

// ───────────────────────── 汇总 ─────────────────────────
if (fails.length) {
  console.error('FAIL  ' + (pass + fails.length - fails.length) + '/' + (pass + fails.length) + ' 通过');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('PASS  ' + pass + '/' + pass + ' 通过  (capNeed: strong=' + NEED_STRONG + ' fast=' + NEED_FAST + ')');
process.exit(0);
