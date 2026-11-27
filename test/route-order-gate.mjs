#!/usr/bin/env node
/**
 * route-order-gate.mjs · 布线变体的排序必须把「贵且无用」的挪到后面
 *
 * 为什么需要它
 * ------------
 * 实测 2026-11-27（ESP32S3_Wireless_Mic_V5，两次运行的真实遥测）：
 *
 *   iter1 的 `ground+pours` 产出 +55 条走线，耗时 73.9s / 61.5s
 *   iter2 再跑**同一个** `ground+pours` ⇒ 0 条新增，却仍花 **87.3s / 60.3s**
 *
 * 两次运行的布线作业总时间 209.5s / 201.0s，其中零/负产出 **111.5s / 100.6s**。
 * 也就是说一半以上的布线时间是「跑完什么也没画」。
 *
 * 规律不是「这个变体不行」（它上一次明明成功了），而是「同一个变体连续用，
 * 边际收益归零，而成本是完整的」。修法是只做**排序**：产出过 -1、贵且空转 -2、
 * 便宜的探针不动；排到后面的变体不删，只是更可能被预算闸自然剪掉。
 *
 * 断言方式
 * --------
 * 排序函数 `routeOrderOf` 内联在 `scripts/pipeline3.js` 里（那是注入 EDA 的函数体，
 * 没有 require）。所以这里**按源码抽出那个函数**再 eval 进来跑 —— 这样测的是真的
 * 出货代码，改了它这里就会红；而不是另写一份仿真自说自话。
 *
 * 退出码：0 通过 / 1 发现了失败 / 2 环境问题（读不到 pipeline3.js）
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'scripts', 'pipeline3.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  [ok] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${extra ? '  ' + extra : ''}`); }
}

let src;
try { src = fs.readFileSync(SRC, 'utf8'); }
catch (e) { console.log('  ROUTEORDER=ENVSKIP  读不到 scripts/pipeline3.js：' + e.message); process.exit(2); }

// ── 从源码里抽出 routeOrderOf（按花括号配对，不做正则臆测）─────────────
function extractFunc(source, name) {
  const decl = new RegExp('function\\s+' + name + '\\s*\\(', 'm');
  const m = decl.exec(source);
  if (!m) return null;
  const open = source.indexOf('{', m.index + m[0].length - 1);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(m.index, i + 1);
    }
  }
  return null;
}

const fnSrc = extractFunc(src, 'routeOrderOf');
if (!fnSrc) { console.log('  ROUTEORDER=ENVSKIP  pipeline3.js 里找不到 routeOrderOf'); process.exit(2); }

let routeOrderOf;
try {
  // eslint-disable-next-line no-new-func
  routeOrderOf = new Function('return (' + fnSrc + ')')();
} catch (e) {
  ok(false, '抽出来的 routeOrderOf 能解析', e.message);
  routeOrderOf = null;
}
if (typeof routeOrderOf !== 'function') {
  console.log('  ROUTEORDER=FAIL  抽出来的 routeOrderOf 不是函数');
  process.exit(1);
}

// ── 1. 纯函数行为：保序 / 降权 / 组合 ─────────────────────────────────
const V = [
  { name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' },
];
{
  const same = routeOrderOf(V, {}).map((x) => x.name).join('');
  ok(same === 'abcd', '分数全 0 时保持原顺序（探针不能被顺手打乱）', same);
  const s1 = routeOrderOf(V, { b: -1 }).map((x) => x.name).join('');
  ok(s1 === 'acdb', '产出过的 -1 排到最后一个 0 分之后', s1);
  const s2 = routeOrderOf(V, { b: -1, c: -2 }).map((x) => x.name).join('');
  ok(s2 === 'adbc', '-2 排在 -1 之后（贵且空转 > 已用尽）', s2);
  const s3 = routeOrderOf(V, { a: 1 }).map((x) => x.name).join('');
  ok(s3 === 'abcd', '正分排最前（未来若引入加分也不会坏）', s3);
  ok(routeOrderOf(V, {}).length === V.length, '排序不丢变体（只是换顺序）');
  ok(JSON.stringify(routeOrderOf(V, { a: -1 }).map((x) => x.name).sort()) === JSON.stringify(['a', 'b', 'c', 'd']),
    '排序是原集合的排列，不增不减');
  // 原数组不能被就地改坏
  const before = V.map((x) => x.name).join('');
  routeOrderOf(V, { a: -5 });
  ok(V.map((x) => x.name).join('') === before, 'routeOrderOf 不修改传入的数组');
}

// ── 2. 回放两次真实运行，断言那次 87s / 60s 的空转被挪到后面 ───────────
// 变体顺序取自 pipeline3.js 的 variants 定义（7 个）。
// 逐轮复算分数，只看排序结果。
const NAMES = ['margin+ground+pours+keep', 'margin+ground+keep', 'ground+pours+keep',
  'margin+keep-only', 'keep-only', 'ground+pours', 'plain'];
const VARIANTS = NAMES.map((n) => ({ name: n }));
{
  // 断言 variants 定义里确实有这 7 个名字（防止改名后这条回放变成空转）
  const missing = NAMES.filter((n) => !src.includes(`'${n}'`));
  ok(missing.length === 0, 'pipeline3.js 里确实有这 7 个变体名', missing.join(','));

  const replay = (label, expectPlainBeforeGroundPours) => {
    const score = {};
    // iter0：只有第一个变体跑了，产出 +599 ⇒ -1
    score['margin+ground+pours+keep'] = -1;
    // iter1：先跑剩下 6 个；前 5 个便宜空转（不改分），ground+pours 产出 +55 ⇒ -1
    score['ground+pours'] = -1;
    // iter2：按分数排序
    const order2 = routeOrderOf(VARIANTS, score).map((x) => x.name);
    const iP = order2.indexOf('plain');
    const iG = order2.indexOf('ground+pours');
    if (expectPlainBeforeGroundPours) {
      ok(iP >= 0 && iG >= 0 && iP < iG, `${label}：iter2 里 plain 排到 ground+pours 之前`
        + `（后者上一轮产出过，本轮实测零产出却花 87s）`, `order=${order2.join(' > ')}`);
    }
    return order2;
  };
  const o1 = replay('失败那次（-115941）', true);
  replay('成功那次（probe-tristate）', true);

  // 反向：如果**不**给 ground+pours 降权，它就还在 plain 之前 —— 证明这条断言有区分度
  const scoreNoDemote = { 'margin+ground+pours+keep': -1 };
  const orderNoDemote = routeOrderOf(VARIANTS, scoreNoDemote).map((x) => x.name);
  ok(orderNoDemote.indexOf('ground+pours') < orderNoDemote.indexOf('plain'),
    '对照：不降权时 ground+pours 仍在 plain 之前（说明降权真的改变了顺序）',
    orderNoDemote.join(' > '));

  // 排序后的第一个必须是「便宜的探针」，不能是贵的那两个
  ok(o1[0] !== 'ground+pours' && o1[0] !== 'margin+ground+pours+keep',
    'iter2 开跑的第一个不是那两个贵的变体', o1[0]);
}

// ── 3. 静态：计分规则与日志真的在代码里 ───────────────────────────────
{
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  ok(/r\.ms\s*>=\s*30000/.test(code), '贵且空转的阈值 30000ms 在代码里');
  ok(/routeScore\[v\.name\]\s*=\s*\(routeScore\[v\.name\]\s*\|\|\s*0\)\s*-\s*2/.test(code), '贵且空转扣 -2');
  ok(/routeScore\[v\.name\]\s*=\s*\(routeScore\[v\.name\]\s*\|\|\s*0\)\s*-\s*1/.test(code), '产出过扣 -1');
  ok(/log\('routeOrder'/.test(code), '顺序变化时记 routeOrder 遥测（否则无从复核）');
  ok(/for \(const v of routeOrder\)/.test(code), '主循环用的是排序后的 routeOrder，不是原 variants');
}

console.log('');
const total = pass + fail;
if (!total) { console.log('  ROUTEORDER=FAIL  一条断言都没跑'); process.exit(1); }
if (fail) { console.log(`  ROUTEORDER=FAIL  ${fail} / ${total} 条断言未过`); process.exit(1); }
console.log(`  ROUTEORDER=PASS  ${total} 条断言全过（纯函数 7 条 + 真实序列回放 5 条 + 静态 5 条）`);
process.exit(0);
