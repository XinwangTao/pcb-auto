#!/usr/bin/env node
/**
 * runall-exitcode-gate.mjs · `run-all.ps1` 的退出码必须是三态，不是二态
 *
 * 为什么需要它
 * ------------
 * 仓库的退出码契约是：`0` 通过 / `1` **发现了失败**（一个结论）/ `2` 环境问题（没能测量）。
 * 这两个非零码的处置**完全相反**：1 ⇒ 去改设计；2 ⇒ 去修机器。
 *
 * 但 `run-all.ps1` 长期只有 `if ($finalOk) { exit 0 } else { exit 1 }`：
 *
 *   - EDA 起不来、`NON_JSON`、设计文件不存在、JSON 解析失败、未捕获异常 —— 全退 **1**
 *   - 「DRC 查出 7 处违规」也退 1
 *
 * 于是自动化层面分不清「这台机器没装 EDA」和「这块板子不行」。测试期实测：
 * `pwsh -File run-all.ps1` 里未捕获的 throw 直接以 1 结束。
 *
 * 现在的判据：六道独立闸门各自是三态（true / false / $null=没测到），
 *   全 true → 0；环境故障或崩溃 → 2；有 false → 1；没有 false 但有 null → 2。
 *
 * 断言两部分：
 *   1. 静态：那段三态计算在、默认退出码是 2、顶层 catch 存在、旧的一行二态已消失；
 *   2. 行为：**真跑**两条必然「没能开工」的路径（设计不存在 / 坏 JSON），必须退 2 ——
 *      这两条不需要 EDA，3 秒内跑完。
 *
 * 退出码：0 通过 / 1 发现了失败 / 2 环境问题（没有 pwsh）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RUNALL = path.join(ROOT, 'run-all.ps1');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  [ok] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${extra ? '  ' + extra : ''}`); }
}

function findPwsh() {
  for (const c of [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    'pwsh.exe',
  ]) {
    const r = spawnSync(c, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}
const PWSH = findPwsh();
if (!PWSH) { console.log('  RUNALLEXIT=ENVSKIP  找不到 pwsh 7'); process.exit(2); }
if (!fs.existsSync(RUNALL)) { console.log('  RUNALLEXIT=ENVSKIP  缺 run-all.ps1'); process.exit(2); }

// ── 1. 静态：三态那段在、默认 2、顶层 catch 在 ──────────────────────
{
  const src = fs.readFileSync(RUNALL, 'utf8');
  // 去掉整行注释再断言：注释里会引用旧表达式（作为「原来写的是什么」的记录），
  // 直接对全文做反向断言会假红。这条坑在 doc-refs 的闸门里踩过。
  const code = src.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

  ok(/退出码三态/.test(src), '有「退出码三态」那一段（注释可读性）');
  ok(/\$script:ExitCode\s*=\s*0/.test(code) && /\$script:ExitCode\s*=\s*1/.test(code) && /\$script:ExitCode\s*=\s*2/.test(code),
    '三态三个分支都真的给 $script:ExitCode 赋值');
  ok(/\$gateFalse\.Count\s*-gt\s*0/.test(code), '用「有 false 的闸门」区分「测过且不行」');
  ok(/\$script:EnvFaultStop\s*-or\s*\$null\s*-ne\s*\$script:Uncaught/.test(code),
    '环境故障与未捕获异常都归到 2');
  ok(/\$script:EnvFaultStop\s*=\s*\$true/.test(code), '环境故障分支真的会置位 EnvFaultStop');
  ok(/^catch\s*\{/m.test(code), '顶层有 catch（未捕获异常不再以 1 结束）');
  ok(/\$script:Uncaught\s*=\s*\$_\s*$/m.test(code), '顶层 catch 记下了异常本身');

  // 旧的二态判定必须消失
  ok(!/^if\s*\(\$finalOk\)\s*\{\s*exit\s+0\s*\}\s*else\s*\{\s*exit\s+1\s*\}/m.test(code),
    '旧的一行二态 `if ($finalOk) { exit 0 } else { exit 1 }` 已不存在');
  // 默认必须退 2：走到末尾却没算出 ExitCode = 没量成
  ok(/exit\s+2\s*$/m.test(code.trim()), '脚本末尾的兜底退出码是 2（没算出 ExitCode = 没量成）');
  // 证据文件要带退出码与原因
  ok(/exitCode\s*=\s*\$script:ExitCode/.test(code), '成功/失败都落盘 exitCode');
  ok(/exitWhy\s*=\s*\$script:ExitWhy/.test(code), '成功/失败都落盘 exitWhy');
}

// ── 2. 行为：两条必然「没能开工」的路径必须退 2 ──────────────────────
function runAll(args, env) {
  const r = spawnSync(PWSH, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', RUNALL, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 180_000, windowsHide: true,
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runallexit-'));
  // 这两条都在碰 EDA 之前就结束，所以不需要装 EDA。
  // PCB_AUTO_LCEDA 指一个存在的文件即可让「找不到 EDA」这道前置检查通过。
  const fakeCli = process.execPath;
  const env = { PCB_AUTO_LCEDA: fakeCli, PCB_AUTO_PWSH: PWSH };

  const r1 = runAll(['-Design', path.join(tmp, '__nope__.json'), '-MaxAttempts', '1'], env);
  ok(r1.code === 2, '设计文件不存在 ⇒ exit 2（不是 1）', `实际 ${r1.code}`);

  const bad = path.join(tmp, 'bad.json');
  fs.writeFileSync(bad, '{ this is not json', 'utf8');
  const r2 = runAll(['-Design', bad, '-MaxAttempts', '1'], env);
  ok(r2.code === 2, '设计 JSON 坏 ⇒ exit 2（不是 1）', `实际 ${r2.code}`);
  ok(/未捕获异常|Exception|JSON/.test(r2.out), '坏 JSON 的原因写出来了（不是静默退 1）',
    r2.out.slice(0, 120));

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { }
}

console.log('');
const total = pass + fail;
if (!total) { console.log('  RUNALLEXIT=FAIL  一条断言都没跑'); process.exit(1); }
if (fail) { console.log(`  RUNALLEXIT=FAIL  ${fail} / ${total} 条断言未过`); process.exit(1); }
console.log(`  RUNALLEXIT=PASS  ${total} 条断言全过（静态 11 条 + 行为 3 条：设计不存在 / 坏 JSON / 原因可见）`);
process.exit(0);
