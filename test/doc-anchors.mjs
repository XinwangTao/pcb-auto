#!/usr/bin/env node
// 闸门：docs/FAILURES.md 里对 pipeline3.js 的行号引用必须「指对」，不只是「指得到」。
//
// 为什么要有这道闸门：
//   test/doc-refs.mjs 只验「被指到的那一行不是空的」。一个偏了 +497 行的引用
//   照样指向一行非空代码，于是 30 多处失效引用在它眼里全绿。
//   实测过两次漂移且**漂移量不是常数**：stitchErr +497、patchNoGeo +582，
//   所以「加个偏移批量修」这种办法本身就是错的。
//
// 判据（可以失败，不是恒真）：
//   文档引用到的源码行集合，必须对下面每一个符号，至少覆盖到一行真的含该符号。
//   行号漂了 ⇒ 集合里找不到那一行 ⇒ 红。
//
// ANCHOR-BASE：文档头部钉住了它写作时对应的 pipeline3.js 哈希。
//   哈希一致 ⇒ 行号必然仍然成立（没人动过文件），直接过。
//   哈希不同 ⇒ 仍然跑上面的语义检查（文件变了但符号没挪走，不该误判成失败）。
//
// 退出码契约：0 通过 / 1 发现失效引用 / 2 环境问题（读不到文件、没有 ANCHOR-BASE）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DOC = path.join(ROOT, 'docs', 'FAILURES.md');
const SRC = path.join(ROOT, 'scripts', 'pipeline3.js');

// 每个符号都是文档**明确声称**存在于 pipeline3.js 里的东西（日志标签 / 常量 / 字段）。
// 覆盖率的边界：只有这张表里的符号受保护；表外的新引用仍然只被 doc-refs 验到「非空」。
// 新增一节引用时，把它的标志性符号加进来，否则它不受保护 —— 这个限制是诚实的，不隐藏。
const SYMBOLS = [
  'clearanceRound', 'clearanceReverted', 'clearanceRevertViaRestoreFail',
  'clearanceRevertViaUnverified', 'viaRestoreDiag',
  'stitchErr', 'stitchRound',
  'patchNoGeo', 'patchNoNet', 'patchNoObj', 'patchTooFar', 'patchIslandPair',
  'patchCrossLayerNoObj', 'patchedCrossLayer',
  'coverage', 'connErrs', 'skipNoAnchor',
  'createPolygon', 'outlineFit', 'PAD_OFFBOARD_TOL',
  'MAX_ROUTE_ITERS', 'routeIter', 'variants',
  'NO_WIRES', 'antennaKeepout',
  '显式摆放',
];

function bail(msg) { console.log('  DOC-ANCHORS=ENVSKIP  ' + msg); process.exit(2); }

let doc, srcText;
try { doc = fs.readFileSync(DOC, 'utf8'); } catch (e) { bail('读不到 docs/FAILURES.md：' + e.message); }
try { srcText = fs.readFileSync(SRC, 'utf8'); } catch (e) { bail('读不到 scripts/pipeline3.js：' + e.message); }

const lines = srcText.split('\n');
const N = lines.length;

const baseMatch = doc.match(/ANCHOR-BASE:[^]*?sha256_12=([0-9A-F]{12})/);
if (!baseMatch) bail('docs/FAILURES.md 里没有 ANCHOR-BASE sha256_12 标记，无法判断行号基准');
const baseSha = baseMatch[1];
const curSha = crypto.createHash('sha256').update(srcText, 'utf8').digest('hex').slice(0, 12).toUpperCase();

function expand(tokStr) {
  const out = new Set();
  for (const raw of tokStr.split(',')) {
    const t = raw.trim();
    const m = t.match(/^(\d+)-(\d+)$/);
    if (m) {
      const a = Number(m[1]), b = Number(m[2]);
      if (a <= b) for (let i = a; i <= b; i++) out.add(i);
    } else if (/^\d+$/.test(t)) out.add(Number(t));
  }
  return out;
}

const cited = new Set();
for (const m of doc.matchAll(/pipeline3\.js:([0-9,\-]+)/g)) {
  for (const n of expand(m[1])) cited.add(n);
}
// §2 正文用的是不带文件名的裸数字（`4299` 起、`4479` 收），必须显式补进来，
// 否则「循环区间」那两句引用不受保护。
for (const m of doc.matchAll(/`(\d{3,4})`\s*起、`(\d{3,4})`\s*收/g)) {
  cited.add(Number(m[1])); cited.add(Number(m[2]));
}

if (!cited.size) bail('文档里一条 pipeline3.js 行号引用都没解析到 —— 判据没有输入，不做判定');

const over = [...cited].filter(n => n < 1 || n > N).sort((a, b) => a - b);
const missing = [];
for (const sym of SYMBOLS) {
  const real = new Set();
  for (let i = 0; i < N; i++) if (lines[i].includes(sym)) real.add(i + 1);
  if (!real.size) { missing.push({ sym, why: 'pipeline3.js 里已经找不到这个符号', real: [] }); continue; }
  const hit = [...real].filter(n => cited.has(n));
  if (!hit.length) missing.push({ sym, why: '文档引用的行里没有它', real: [...real].sort((a, b) => a - b).slice(0, 6) });
}

const drift = baseSha === curSha;
console.log(`  引用覆盖 ${cited.size} 行（范围 ${Math.min(...cited)}..${Math.max(...cited)}），源文件 ${N} 行`);
console.log(`  ANCHOR-BASE ${baseSha} / 当前 ${curSha} ⇒ ${drift ? '一致（行号基准未动）' : '已漂移（改跑语义检查）'}`);
console.log(`  受保护符号 ${SYMBOLS.length} 个`);

if (over.length) {
  console.log(`  DOC-ANCHORS=FAIL  ${over.length} 个行号越界（文件只有 ${N} 行）：${over.slice(0, 8).join(', ')}`);
  process.exit(1);
}
if (missing.length) {
  console.log(`  DOC-ANCHORS=FAIL  ${missing.length} 个符号没有任何引用指向含它的行：`);
  for (const m of missing) {
    console.log(`    ✗ ${m.sym} —— ${m.why}` + (m.real.length ? `（真实在 ${m.real.join(', ')}）` : ''));
  }
  console.log('  修法：按内容重锚，不要加偏移（漂移量不是常数）。改完更新文档头部的 ANCHOR-BASE 哈希。');
  process.exit(1);
}
console.log(`  DOC-ANCHORS=PASS  ${SYMBOLS.length} 个符号全部覆盖，${cited.size} 处引用无一越界`);
