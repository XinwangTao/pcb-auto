#!/usr/bin/env node
/**
 * drc-verdict-gate.mjs · 独立 DRC 复核的退出码必须与「真实含义」对上
 *
 * 为什么需要它
 * ------------
 * `scripts/verify-drc.js` 的退出码契约是：`0` 通过 / `1` 有违规（一个结论）/ `2` 没量成。
 * 这三者的**处置完全相反**：有违规 ⇒ 换板框再试；没量成 ⇒ 停止自愈阶梯、保留产物
 * （对这块板一个判断都没下过，换板没有任何依据）。
 *
 * 2026-11-27 对抗性审查实测，原实现在**两个方向**上都归错类：
 *
 *   1. `consistent = passed ? (itemsErr === null && total === 0) : true`
 *      —— `passed=false` 时恒为 `true`。于是「明细取不到」走 exit 1（= 有违规），
 *      run-all 打印「违规 处」并把一块**没量过的板**换成更宽的板，白烧 6~10 分钟。
 *
 *   2. `passed=true` 但明细非空 → `consistent=false` → exit 2（= 环境异常）。
 *      真相是这块板**确实有违规**，却被记成「量具坏了」。
 *
 * 顺带发现第三种原实现没考虑的组合：`passed=false` 且 `total=0`
 * —— 说不通过却一条都列不出，这既不是通过也不是「有违规」，是结论不可采信。
 *
 * 断言方式
 * --------
 * 裁定逻辑抽在 `scripts/drc-verdict.js`（纯函数），所以这里可以**直接喂构造信封**
 * 断言退出码，不需要 EDA、不需要 9 分钟。另有两条静态断言钉住「调用点真的用它」，
 * 避免出现「函数写得对、但没人调用」这种形状。
 *
 * 退出码：0 通过 / 1 发现了失败 / 2 环境问题
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  [ok] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${extra ? '  ' + extra : ''}`); }
}
function eq(got, want, name) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(g === w, name, g === w ? '' : `实际 ${g} ≠ 期望 ${w}`);
}

// ── 加载纯裁定模块 ─────────────────────────────────────────────────────
let mod;
try {
  mod = require(path.join(ROOT, 'scripts', 'drc-verdict.js'));
} catch (e) {
  console.log('  DRCVERDICT=ENVSKIP  加载 scripts/drc-verdict.js 失败：' + e.message);
  process.exit(2);
}
const { classify, decide, VERDICT_TABLE } = mod;
if (typeof classify !== 'function' || typeof decide !== 'function') {
  console.log('  DRCVERDICT=ENVSKIP  drc-verdict.js 没有导出 classify/decide');
  process.exit(2);
}

// ── 1. 五种「两个信号」组合的退出码（核心表）──────────────────────────
// 这是整道闸门的重点：每一行的「真实含义」不同，退出码必须不同。
const SIGNAL_CASES = [
  // 描述                                        passed  itemsErr  total  退出码 裁定
  ['真的通过（自述通过 + 明细 0 条）',           true,   null,     0,     0, 'clean'],
  ['自述通过但明细 3 条（异步窗口）= 有违规',     true,   null,     3,     1, 'violations'],
  ['自述不通过 + 明细 3 条 = 有违规',            false,  null,     3,     1, 'violations'],
  ['自述不通过 + 明细 0 条 = 结论不可采信',       false,  null,     0,     2, 'contradictory'],
  ['明细取不到（passed 不管是什么）= 没量成',     false,  'timeout', 0,     2, 'no-detail'],
  ['明细取不到 + 自述通过 = 没量成',             true,   'timeout', 0,     2, 'no-detail'],
];
for (const [desc, passed, itemsErr, total, wantCode, wantVerdict] of SIGNAL_CASES) {
  const r = classify({ passed, itemsErr, total });
  eq([r.code, r.verdict], [wantCode, wantVerdict], `退出码/裁定：${desc}`);
}

// ── 2. total 缺失 与 passed 缺失 ──────────────────────────────────────
{
  const r1 = classify({ passed: true, itemsErr: null });
  eq([r1.code, r1.verdict], [2, 'no-total'], 'total 缺失 ⇒ 没量成（不能当通过）');
  const r2 = classify({ itemsErr: null, total: 0 });
  eq([r2.code, r2.verdict], [2, 'no-passed'], 'passed 缺失 ⇒ 没量成（不能当通过）');
  const r3 = classify({});
  eq(r3.code, 2, '空对象 ⇒ 没量成');
}

// ── 3. 信封层（CLI 没跑成 / EDA 拒绝）─────────────────────────────────
{
  eq(decide({ ok: false, error: 'SPAWN_OWNER_FAILED' }).code, 2, '信封 ok=false ⇒ 2');
  eq(decide(null).code, 2, '信封为 null ⇒ 2');
  eq(decide({ ok: true }).code, 2, '信封没有 value ⇒ 2');
  eq(decide({ ok: true, value: { ok: false, error: 'no board' } }).code, 2,
    '内层拒绝了（value.ok===false）⇒ 2，不能当成「有违规」');
  // 正常信封
  const good = decide({ ok: true, value: { ok: true, passed: true, itemsErr: null, total: 0 } });
  eq([good.code, good.verdict], [0, 'clean'], '完整且干净的信封 ⇒ 0');
}

// ── 4. 与 VERDICT_TABLE 一致（防两处口径漂移）──────────────────────────
{
  const seen = new Set();
  const allVerdicts = [
    ...SIGNAL_CASES.map((c) => c[5]),
    'no-total', 'no-passed', 'bad-envelope', 'cli-refused', 'no-value', 'eda-refused',
  ];
  for (const v of allVerdicts) {
    seen.add(v);
    const t = VERDICT_TABLE[v];
    if (!t) { fail++; console.log(`  [FAIL] VERDICT_TABLE 缺 ${v}`); continue; }
    ok([0, 1, 2].includes(t.code), `表里 ${v} 的退出码是 0/1/2 之一`, `得到 ${t.code}`);
  }
  // 只有 clean 是 0；只有 violations 是 1
  const codes = Object.entries(VERDICT_TABLE).map(([k, v]) => [k, v.code]);
  eq(codes.filter(([, c]) => c === 0).map(([k]) => k), ['clean'], '整个表里只有 clean 退 0');
  eq(codes.filter(([, c]) => c === 1).map(([k]) => k), ['violations'], '整个表里只有 violations 退 1');
  ok(codes.length >= 10, '表覆盖了所有已知裁定', `实际 ${codes.length} 条`);
}

// 【先剥掉整行注释再断言】实测 2026-11-27 踩过两次：
//   1) 注释里引用了旧表达式（作为「原来写的是什么」的记录），于是
//      「旧式子已不存在」这条反向断言假红；
//   2) 更阴险的一次：用 ^[ \t]*(?!#) 想排除注释行，但 [ \t]* 会**回溯** ——
//      少匹配一个空格后 (?!#) 面对的是空格而不是 '#'，于是注释行照样命中。
//   结论：反向断言要在「注释已被物理移除」的文本上做，不要跟正则玩推理。
function stripComments(src) {
  return src.split('\n')
    .filter((l) => { const s = l.trim(); return !(s.startsWith('#') || s.startsWith('//')); })
    .join('\n');
}

// ── 4.5 接线：decide 必须把内层字段名映射到 classify 的入参 ───────
//
// 【这条是真机教训】实测 2026-11-27：纯函数闸门 36 条全绿，但真机跑
// verify-drc.js 一律裁成 no-passed（exit 2）—— 因为内层当时返回的字段叫
// passedRaw，而 classify 读的是 passed。单元测试测不出“单元对、接线错”。
{
  const src = decide.toString();
  ok(/classify\(\{\s*passed:\s*v\.passed/.test(src),
    'decide() 显式把 v.passed 映射进 classify（不是靠字段名恰好相同）');
  ok(/itemsErr:\s*v\.itemsErr/.test(src) && /total:\s*v\.total/.test(src),
    'decide() 也映射 itemsErr / total（三个信号一个都不能丢）');
  // 内层必须以字段 passed 传出自述，否则上面的映射拿到 undefined
  const vdSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'verify-drc.js'), 'utf8');
  const inner = vdSrc.slice(vdSrc.indexOf('const INNER = `'));
  ok(/^\s*passed,\s*$/m.test(inner), 'INNER 层以 passed 字段传出自述（不是另取名字）');
}

// ── 5. 静态：调用点真的用了裁定（防「函数写得对、没人调用」）──────────
{
  const vd = path.join(ROOT, 'scripts', 'verify-drc.js');
  const src = stripComments(fs.readFileSync(vd, 'utf8'));
  // 行首锚定 + 排除注释：只匹配子串的断言在被注释掉之后照样「通过」（踩过）
  const uses = /^[ \t]*(?!#).*require\(['"]\.\/drc-verdict\.js['"]\)/m.test(src);
  ok(uses, 'verify-drc.js 真的 require 了 drc-verdict.js');
  const exits = /^[ \t]*(?!#).*process\.exit\(d\.code\)/m.test(src);
  ok(exits, 'verify-drc.js 的退出码来自裁定结果（process.exit(d.code)）');
  // 反向：那个恒真的三元式必须消失
  const vacuous = /passed\s*\?\s*\(?\s*itemsErr\s*===\s*null/.test(src);
  ok(!vacuous, '旧的恒真式 consistent = passed ? … : true 已不存在');
  // 反向：不该再有内联三元决定退出码
  const inlineExit = /process\.exit\(\s*v\.passed\s*===/.test(src);
  ok(!inlineExit, '旧的 process.exit(v.passed === true ? …) 已不存在');
}

// ── 6. 静态：run-all 用裁定字段而不是字符串前缀 ────────────────────────
{
  const ra = path.join(ROOT, 'run-all.ps1');
  let src = '';
  try { src = stripComments(fs.readFileSync(ra, 'utf8')); }
  catch (e) { console.log('  DRCVERDICT=ENVSKIP  读不到 run-all.ps1'); process.exit(2); }
  const usesVerdict = /\$drcReVerdict\s*-ne\s*'violations'/.test(src);
  ok(usesVerdict, 'run-all.ps1 用 $drcReVerdict 区分「有违规」与「没量成」');
  // 反向：那条靠措辞的判据必须消失（它在注释里出现是可以的）
  const prefixMatch = /-match\s+'\^违规'/.test(src);
  ok(!prefixMatch, '不再用 $drcReNote -match \'^违规\' 这种靠措辞的判据');
  // stdout/stderr 分开收：否则 stderr 一有字，JSON 就永远解析不了
  const sepErr = /verify-drc\.js'\)\s*\$v\.projectUuid\s*\$sid\s*2>\$drcReErrFile/.test(src);
  ok(sepErr, 'verify-drc 的 stdout 与 stderr 分开收（JSON 才可能解析成功）');
}

// ── 汇总 ──────────────────────────────────────────────────────────────
console.log('');
const total = pass + fail;
if (!total) { console.log('  DRCVERDICT=FAIL  一条断言都没跑'); process.exit(1); }
if (fail) { console.log(`  DRCVERDICT=FAIL  ${fail} / ${total} 条断言未过`); process.exit(1); }
console.log(`  DRCVERDICT=PASS  ${total} 条断言全过（6 种信号组合 + 信封 5 种 + 表一致性 + 调用点 6 条）`);
process.exit(0);
