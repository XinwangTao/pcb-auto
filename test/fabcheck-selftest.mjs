#!/usr/bin/env node
'use strict';
/**
 * test/fabcheck-selftest.mjs —— 把 `fabcheck --selftest` 接进闸门链。
 *
 * 为什么需要这个包装器：
 *   `--selftest` 一直是**坏的**，而且坏了很久没人发现，因为它不在 `npm test` 里。
 *   一个不跑的测试不是测试。实测（2026-11-26T19:43）它红在
 *   「坏样本命中 gerber.mask.top.empty」——根因是故障注入只剥掉了 GTS 的 153 条 D03，
 *   而那条判据判的是「0 图元」，剥完还剩 606 条 D01 + 6 个 G36 区域 = 612，
 *   判据当然不响。换句话说：**自检红的原因跟被测对象无关**，这比没有自检更坏 ——
 *   它会教人把这条闸门当噪音。
 *
 * 退出码契约（与 test/ 下其它闸门一致）：
 *   0 = 自检通过（坏样本被判红、好样本被判绿）
 *   1 = 自检**发现**了问题（fabcheck 的行为不再符合它自己声明的契约）
 *   2 = 环境问题（缺样本 / 跑不起来）—— 不能归到 1，否则没人分得清
 *       「我的代码坏了」和「这台机器上没有样本」
 *
 * 样本用版本化的 test/mutants/base，不用 out/ 下的运行产物：
 *   out/ 会被 cleanup.ps1 清理，而闸门不能依赖一个会被删掉的东西。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FAB = path.join(ROOT, 'scripts', 'fabcheck.js');
const BASE = path.join(ROOT, 'test', 'mutants', 'base');

const need = [FAB, path.join(BASE, 'Gerber.zip'), path.join(BASE, 'PnP.csv'), path.join(BASE, 'BOM.xlsx')];
const missing = need.filter((p) => !fs.existsSync(p));
if (missing.length) {
  console.error(`FABCHECK-SELFTEST=NOSAMPLE 缺输入：${missing.map((p) => path.relative(ROOT, p)).join(', ')}`);
  process.exit(2);
}

let out, code;
try {
  out = execFileSync(process.execPath, [FAB, '--selftest', BASE], {
    encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  code = 0;
} catch (e) {
  // 退出码 1 是「自检发现了失败」，stdout 里仍有完整报告 —— 要读它，不要当成跑不起来。
  out = e.stdout || '';
  code = typeof e.status === 'number' ? e.status : 2;
  if (!String(out).trim()) {
    console.error(`FABCHECK-SELFTEST=NOSAMPLE 自检没产出任何 stdout（status=${code}）：${String(e.stderr || e.message).slice(0, 400)}`);
    process.exit(2);
  }
}

let j = null;
try { j = JSON.parse(out); } catch (_) {
  console.error(`FABCHECK-SELFTEST=NOSAMPLE 输出不是 JSON：${String(out).slice(0, 300)}`);
  process.exit(2);
}

if (code === 0 && j.selftest === 'PASS') {
  const cases = j.cases || [];
  const neg = cases.filter((c) => c.ok).length;
  // 分母要写清：断言里有几条是「坏样本必须命中」、几条是「好样本必须绿」。
  // 只报「PASS」而不说判了几条，等于没有分母的结论。
  if (!neg) {
    console.error('FABCHECK-SELFTEST=NOSAMPLE 自检报 PASS 但一条断言都没有 —— 空集不能算通过');
    process.exit(2);
  }
  console.log(`  FABCHECK-SELFTEST=PASS ${neg} 条断言全过（好样本 exit=${j.exitGood} / 坏样本 exit=${j.exitBad}）`);
  console.log('                          样本 test/mutants/base（版本化，不依赖会被清理的 out/）');
  process.exit(0);
}

// 走到这里 = 自检判了自己红。这是「发现失败」，不是环境问题。
const why = j.error || '未知';
console.error(`  FABCHECK-SELFTEST=FAIL exit=${code}：${why}`);
for (const c of (j.cases || [])) if (!c.ok) console.error(`      ✗ ${c.msg}`);
process.exit(1);
