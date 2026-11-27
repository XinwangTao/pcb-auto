#!/usr/bin/env node
/**
 * rundir-space-gate.mjs · 路径含空格时，`run-all` 的输出目录必须仍能解析出来
 *
 * 缺陷（2026-11-27 对抗性审查）
 * ----------------------------
 * `core/ops.mjs` 用
 *     /(?:流水线启动|输出目录|runDir)[^\n]*?([A-Za-z]:[\\/][^\s"']+)/
 * 从 run-all 的输出里取输出目录。`[^\s"']+` 遇到空白就停 —— 于是
 *
 *     [pcb-auto] 流水线启动：X -> C:\Users\John Doe\Documents\pcb-auto\out\X-20261127-101010
 *
 * 会被截成 `C:\Users\John` ⇒ `existsSync` 假 ⇒ runDir 空 ⇒ 读不到 `_run.json` ⇒
 * 返回 `ok:false` / `drcPassed:false` / `exportsOk:0/0`，而 **exitCode 是 0**。
 * 一次成功构建被报成失败。作者机器路径无空格，所以本机永远复现不出来。
 *
 * 断言方式
 * --------
 * 直接 import 出货的 `extractRunDir`，喂构造文本 + 构造的存在性判定。
 * 不看代码长相，看它吐出来的路径对不对。
 *
 * 退出码：0 通过 / 1 发现了失败 / 2 环境问题（加载不了 core/ops.mjs）
 */
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  [ok] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${extra ? '  ' + extra : ''}`); }
}

let extractRunDir;
try {
  ({ extractRunDir } = await import(url.pathToFileURL(path.join(ROOT, 'core', 'ops.mjs')).href));
} catch (e) {
  console.log('  RUNDIR=ENVSKIP  加载 core/ops.mjs 失败：' + e.message);
  process.exit(2);
}
if (typeof extractRunDir !== 'function') {
  console.log('  RUNDIR=ENVSKIP  core/ops.mjs 没有导出 extractRunDir');
  process.exit(2);
}

// 构造一个「只有这些路径算存在」的判定
const mkExists = (set) => (p) => set.includes(p);

const CASES = [
  {
    name: '普通路径',
    dir: 'D:\\proj\\pcb-auto\\out\\X-20261127-101010',
    text: '[pcb-auto] 流水线启动：X -> D:\\proj\\pcb-auto\\out\\X-20261127-101010\n',
  },
  {
    name: '**含空格的路径**（旧实现在这里截断）',
    dir: 'C:\\Users\\John Doe\\Documents\\pcb-auto\\out\\X-20261127-101010',
    text: '[pcb-auto] 流水线启动：X -> C:\\Users\\John Doe\\Documents\\pcb-auto\\out\\X-20261127-101010\n',
  },
  {
    name: '含空格 + 中文',
    dir: 'D:\\用户 目录\\板子 项目\\out\\X-20261127-101010',
    text: '[pcb-auto] 流水线启动：X -> D:\\用户 目录\\板子 项目\\out\\X-20261127-101010\n',
  },
  {
    name: '行尾还跟了别的字',
    dir: 'C:\\My Projects\\pcb\\out\\X-20261127-101010',
    text: '[pcb-auto] 产物目录       : C:\\My Projects\\pcb\\out\\X-20261127-101010  （自愈策略：smart-fit）\n',
  },
  {
    name: '被引号括起来',
    dir: 'C:\\Program Data\\pcb\\out\\X-20261127-101010',
    text: '[pcb-auto] runDir -> "C:\\Program Data\\pcb\\out\\X-20261127-101010"\n',
  },
  {
    name: '前面还有别的盘符干扰',
    dir: 'E:\\with space\\out\\X-20261127-101010',
    text: '[pcb-auto] 先看 D:\\nope 再 输出目录: E:\\with space\\out\\X-20261127-101010\n',
  },
];

for (const c of CASES) {
  const got = extractRunDir(c.text, mkExists([c.dir]));
  ok(got === c.dir, `能取出：${c.name}`, `实际 ${JSON.stringify(got)}`);
}

// 反向：路径不存在时必须给空串（由调用方回退到 newestRunDir），不能编一个
{
  const got = extractRunDir('[pcb-auto] 流水线启动：X -> C:\\not\\here\\out\\X-20261127-101010\n', () => false);
  ok(got === '', '路径不存在时返回空串（交给 newestRunDir 兜底），不编造', JSON.stringify(got));
}

// 反向：完全没有标记时走第二条路（形如 out/<name>-YYYYMMDD-HHMMSS）
{
  const dir = 'F:\\a b\\out\\X-20261127-101010';
  const got = extractRunDir('随便什么日志 F:\\a b\\out\\X-20261127-101010 结束', mkExists([dir]));
  ok(got === dir, '没有标记时仍能从 out/…-时间戳 的尾巴认出来', JSON.stringify(got));
}

// 【这条是旧实现的具体失效证明】不是断言旧代码，而是断言「截断点确实更短」，
// 免得以后有人把逐字回退改回「遇到空格就停」还觉得没问题。
{
  const full = 'C:\\Users\\John Doe\\Documents\\pcb-auto\\out\\X-20261127-101010';
  const truncatedAtFirstSpace = full.split(' ')[0];   // 旧行为：在第一个空格处截断
  ok(truncatedAtFirstSpace !== full,
    '这个样本确实能在空格处被截断（否则上面那条断言没有区分度）');
  ok(truncatedAtFirstSpace.length < full.length,
    '截断后的长度严格更短 —— 说明「靠空格定边界」必然丢信息');
  const got = extractRunDir('[pcb-auto] 流水线启动：X -> ' + full + '\n', mkExists([full]));
  ok(got === full && got.length > truncatedAtFirstSpace.length,
    '**新实现不再被空格截断**（长度等于完整路径）', `got 长度 ${got.length} / full ${full.length}`);
}

console.log('');
const total = pass + fail;
if (!total) { console.log('  RUNDIR=FAIL  一条断言都没跑'); process.exit(1); }
if (fail) { console.log(`  RUNDIR=FAIL  ${fail} / ${total} 条断言未过`); process.exit(1); }
console.log(`  RUNDIR=PASS  ${total} 条断言全过（6 种路径形态 + 3 条反向/区分度）`);
process.exit(0);
