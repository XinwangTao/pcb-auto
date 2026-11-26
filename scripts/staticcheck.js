#!/usr/bin/env node
/*
 * staticcheck.js —— 语法闸门第二关：抓「语法合法但一跑就 ReferenceError」的中间态
 *
 * 真实事故（同一天两次，合计白跑 1091s）
 * --------------------------------------
 * ① d8-led-8ch 20:13 启动，598s 后失败：
 *      EXECUTION_ERROR: drcLeafCount is not defined  (ReferenceError)
 *    文件处在"return 对象已引用 drcLeafCount、`let drcLeafCount` 还没写进去"的中间态。
 * ② 20:29 启动的 8 路 LED，493s 后同样失败 —— 那一版声明**是存在的**，
 *    只是被包在更深的块里，return 处拿不到。
 * 两次 `new vm.Script` 都合法，所以第一关放行，一次真实运行直接烧光。
 *
 * 做法
 * ----
 * 用真正的 JS 解析器（acorn）+ 真正的作用域分析（eslint-scope），
 * 只问一件事：
 *
 *     最后那个 `return { ... }` 里的**裸简写**成员，是否都能解析到某个声明？
 *
 * 为什么不用手写扫描器：第一版手搓"按括号深度切语句"，被 pipeline3.js 里大量
 * 模板字符串（`${...}`）带歪 —— isCode/depth 状态从第一个插值起就错位，
 * 结果连真实文件里存在的 `let drcLeafCount` 都认不出来，删掉声明也照样放行。
 * 手写词法分析在这里是错的选择；现成的解析器就在 video/node_modules 里。
 *
 * 为什么范围只有 return 对象
 * -------------------------
 * 初版试过全文重复声明检测，误报上百条（无作用域分析时每个 for 体、每个函数里的
 * 同名变量都会被判重复）。噪声闸门比没有闸门更糟：它会让 .lastgood 永久生效，
 * 把所有后续改进挡在外面。return 对象是流水线唯一的对外契约，也是历史上
 * 真正出问题的位置，收益/误报比最高。
 *
 * 退出码
 *  0 通过
 *  1 有问题（调用方应阻断本次运行、回退 .lastgood）
 *  2 用法 / IO / 解析器不可用（调用方**必须**视为"跳过"，不是失败 ——
 *    否则一次环境问题就会把所有运行永久钉在 .lastgood 上）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = process.argv[2];
if (!file) { console.error('用法: node staticcheck.js <pipeline3.js>'); process.exit(2); }
let src;
try { src = fs.readFileSync(file, 'utf8'); }
catch (e) { console.error(`读不到文件: ${file}: ${e.message}`); process.exit(2); }

const problems = [];
function report() {
  if (!problems.length) {
    console.log(JSON.stringify({ tool: 'staticcheck', file, ok: true }));
    process.exit(0);
  }
  console.log(JSON.stringify({
    tool: 'staticcheck', file, ok: false,
    problems: problems.slice(0, 12), total: problems.length,
  }));
  process.exit(1);
}

// ---- 1. 语法（快、无依赖，先做）----
try { new vm.Script('(async function(){\n' + src + '\n})'); }
catch (e) { problems.push(`语法错误: ${e.message}`); report(); }

// ---- 1.5 丢弃图元 API 返回值（纯文本扫，不依赖解析器）----
// 背景：pcb_PrimitiveLine/Via 的 delete 失败 resolve(false)、modify 失败 resolve(undefined)，
// **两者都不抛**。所以 `try { await ...delete(id) } catch {}` 对最常见的失败完全免疫，
// "没抛就算成功"于是把静默失败记成成功。2026-11-25 的审计在 pipeline3.js 里找到 7 处，
// 其中 delObj 那处让失败的删除对象被移出重试队列，脏铜永久留在板上。
// 这属于"不影响 ok 判定、所以能活很久"的一类，必须静态拦住。
(function checkRetVal() {
  const TARGET = /pcb_Primitive(?:Line|Via|Pad|Pour|Region|Polyline|Fill)\b/;
  // 按**调用点**判断，不能按整行：`if (cond) await ...delete(id);` 行内有 === 却仍是丢弃。
  const isConsumed = (line, idx) => {
    const before = line.slice(0, idx), after = line.slice(idx);
    if (/(^|[^=!<>])=(?!=)/.test(before)) return true;   // 赋值接住
    if (/===|!==/.test(after)) return true;              // 参与比较
    if (/\breturn\s*$/.test(before)) return true;        // 交出
    if (/[?:]\s*$/.test(before)) return true;            // 多行三元的某个分支
    return false;
  };
  const re = /await\s+eda\b[A-Za-z0-9_.]*\s*\.\s*(?:delete|modify)\s*\(/g;
  const rows = src.split('\n');
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i], tr = raw.trim();
    if (!tr || tr.startsWith('//') || !TARGET.test(tr)) continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(raw)) !== null) {
      if (!isConsumed(raw, m.index)) {
        problems.push(`丢弃了 delete/modify 的返回值（失败时 resolve(false/undefined) 不抛异常，` +
          `try/catch 抓不到）L${i + 1}: ${tr.slice(0, 110)}`);
      }
    }
  }
})();

// ---- 2. 加载解析器；拿不到就 exit 2（跳过，不是失败）----
function loadFromCandidates(mod) {
  const roots = [
    path.join(__dirname, '..', 'video', 'node_modules'),
    path.join(process.cwd(), 'video', 'node_modules'),
    path.join(__dirname, 'node_modules'),
    process.cwd(),
  ];
  for (const r of roots) {
    try { return require(path.join(r, mod)); } catch (e) { /* 继续试下一个 */ }
  }
  try { return require(mod); } catch (e) { /* 最后兜底 */ }
  return null;
}
const acorn = loadFromCandidates('acorn');
const eslintScope = loadFromCandidates('eslint-scope');
if (!acorn || !eslintScope) {
  console.error(`解析器不可用（acorn=${!!acorn} eslint-scope=${!!eslintScope}），本关跳过`);
  // 【exit 2 不能吞掉已证实的缺陷】exit 2 的语义是「本关跳过」，而 run-all 只在 exit 1 时阻断。
  // 但 1.5 段（纯文本扫 delete/modify 返回值）不依赖解析器，它收集到的问题是真的；
  // 若直接 exit 2，「已证实的缺陷」会因为「解析器缺了」而被一起抹掉。
  if (problems.length) report();
  process.exit(2);
}

// ---- 3. 解析成 AST（整体包一层 async function，模拟真实执行环境）----
const PREFIX = '(async function(){\n';
let ast;
try {
  ast = acorn.parse(PREFIX + src + '\n})', {
    ecmaVersion: 'latest', sourceType: 'script',
    locations: true, ranges: true, allowAwaitOutsideFunction: true,
  });
} catch (e) {
  problems.push(`语法错误(acorn): ${e.message}`);
  report();
}

// ---- 4. 作用域分析 ----
let scopeManager;
try {
  scopeManager = eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType: 'script' });
} catch (e) {
  console.error(`作用域分析失败（本关跳过）: ${e.message}`);
  // 【exit 2 不能吞掉已证实的缺陷】exit 2 的语义是「本关跳过」，而 run-all 只在 exit 1 时阻断。
  // 但 1.5 段（纯文本扫 delete/modify 返回值）不依赖解析器，它收集到的问题是真的；
  // 若直接 exit 2，「已证实的缺陷」会因为「解析器缺了」而被一起抹掉。
  if (problems.length) report();
  process.exit(2);
}

// ---- 5. 找到最后一个 `return { ... }` ----
function findLastReturn(node, acc) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) { for (const c of node) acc = findLastReturn(c, acc); return acc; }
  if (node.type === 'ReturnStatement' && node.argument && node.argument.type === 'ObjectExpression') {
    return node;   // 深度优先、后写覆盖前写 → 得到最后一个
  }
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'range' || k === 'start' || k === 'end') continue;
    const v = node[k];
    if (v && typeof v === 'object') acc = findLastReturn(v, acc);
  }
  return acc;
}
const ret = findLastReturn(ast, null);
if (!ret) {
  // 没有 return 对象说明文件结构不是预期形态（可能正在大改）→ 跳过，不误报
  console.error('未找到 return { ... }，本关跳过');
  // 【exit 2 不能吞掉已证实的缺陷】exit 2 的语义是「本关跳过」，而 run-all 只在 exit 1 时阻断。
  // 但 1.5 段（纯文本扫 delete/modify 返回值）不依赖解析器，它收集到的问题是真的；
  // 若直接 exit 2，「已证实的缺陷」会因为「解析器缺了」而被一起抹掉。
  if (problems.length) report();
  process.exit(2);
}

// ---- 6. 建立「标识符节点 → 是否解析到声明」的索引 ----
// eslint-scope 把没解析到任何声明的引用放在 unresolved（scope.through）。
const unresolvedNodes = new Set();
(function collectThrough(scope) {
  if (!scope) return;
  for (const ref of scope.through) {
    if (ref && ref.resolved === null) unresolvedNodes.add(ref.identifier);
  }
  for (const s of (scope.childScopes || [])) collectThrough(s);
})(scopeManager.globalScope);

// 真·全局对象（不是拼写错误）。只列确实会被 return 直接引用的那些。
const KNOWN_GLOBALS = new Set([
  'undefined', 'NaN', 'Infinity', 'globalThis',
  'console', 'Math', 'JSON', 'Date', 'Array', 'Object', 'String', 'Number',
  'Boolean', 'Promise', 'Set', 'Map', 'Symbol', 'RegExp', 'Error', 'Blob',
  'Uint8Array', 'ArrayBuffer', 'TextEncoder', 'TextDecoder', 'URL',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'fetch',
  'process', 'require', 'module', 'exports', '__dirname', '__filename',
]);

// ---- 7. 逐个检查 return 对象的裸简写成员 ----
for (const prop of ret.argument.properties) {
  if (!prop || prop.type !== 'Property' || prop.computed) continue;
  if (!prop.shorthand) continue;                       // 只认裸简写 `{ foo }`
  const id = prop.value;
  if (!id || id.type !== 'Identifier') continue;
  const name = id.name;
  if (KNOWN_GLOBALS.has(name)) continue;
  if (unresolvedNodes.has(id)) {
    problems.push(`return 对象引用了不可见的标识符: ${name}（运行时必然 ReferenceError）`);
  }
}

report();
