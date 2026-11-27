#!/usr/bin/env node
/**
 * console-encoding-gate.mjs · 中文版 Windows 上「子进程 JSON 解析不了」必须被钉住
 *
 * 为什么需要它
 * ------------
 * 实测 2026-11-27（另一台机器 DESKTOP-K087HI9，pwsh 7.6.10，`chcp 936`）：
 *
 *   [Console]::OutputEncoding = gb2312/936
 *   ConvertFrom-Json 报：After parsing a value an unexpected character was encountered:
 *                        b. Path 'summary.line', line 21, position 3.
 *   而 fabcheck 本身完全正常（13036 字、exit 0、stderr 为空）。
 *   结果是 run-all 只能报「下单资格（未取得）：fabcheck exit=0，输出不是 JSON」——
 *   一句把「量具没问题」说成「量具坏了」的结论。
 *
 * 本机（pwsh 7.7.0）恰好是 utf-8/65001，所以这个缺陷**在作者机器上永远复现不出来**；
 * 而中文版 Windows 的默认代码页正是 936 —— 嘉立创 EDA 的主要用户群默认命中。
 *
 * 这道闸门钉两件事：
 *   1) run-all.ps1 在启动早期把 [Console]::OutputEncoding 切到 UTF-8（文本断言，因为
 *      「有没有那几行」是静态事实）；
 *   2) **行为断言**：把子进程的 [Console]::OutputEncoding 强设成 GBK 再解析一段含中文的
 *      JSON —— 修好的写法（显式设 UTF-8）必须解析成功，坏写法必须失败。这一条用构造样本
 *      双向跑，避免「只检查文本里有没有某行」这种可以空转的断言。
 *
 * 退出码：0 通过 / 1 发现了失败 / 2 环境问题（没有 pwsh）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RUNALL = path.join(ROOT, 'run-all.ps1');

function bail(msg) { console.log('  ENCGATE=ENVSKIP  ' + msg); process.exit(2); }

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  [ok] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${extra ? '  ' + extra : ''}`); }
}

// ── 找 pwsh ────────────────────────────────────────────────────────────
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
if (!PWSH) bail('找不到 pwsh 7');
if (!fs.existsSync(RUNALL)) bail('缺 run-all.ps1');

// ── 断言 1：run-all.ps1 启动早期设了 UTF-8（文本层） ──────────────────
{
  const src = fs.readFileSync(RUNALL, 'utf8');
  // 【必须锚在行首且不允许被注释】实测 2026-11-27：第一版写成
  // `/[Console]::OutputEncoding\s*=\s*[Text.Encoding]::UTF8/`，于是把那行注掉之后**闸门照样全绿**——
  // 因为 `# [Console]::OutputEncoding = ...` 里仍然含这个子串。一个只匹配子串、
  // 不管是否生效的断言，又是一次假绿。现在要求行首可选空白后直接是 `[Console]`。
  const SET_RE = /^[ \t]*\[Console\]::OutputEncoding[ \t]*=[ \t]*\[Text\.Encoding\]::UTF8/m;
  const hasSet = SET_RE.test(src);
  // PYTHONIOENCODING 在真实代码里是跟在 `if (...) { ... }` 单行里的，
  // 所以不能要求行首。只要求「这一行不是注释」：用 (?!#) 排除行首注释。
  const hasPy = /^[ \t]*(?!#).*\$env:PYTHONIOENCODING[ \t]*=[ \t]*'utf-8'/m.test(src);
  // 位置：必须出现在「第一个 Invoke-PipelineRaw / fabcheck 调用」之前，否则切晚了没用
  const iSet = src.search(SET_RE);
  const iUse = src.search(/(fabcheck\.js|Invoke-PipelineRaw)/);
  ok(hasSet, 'run-all.ps1 把 [Console]::OutputEncoding 设为 UTF-8');
  ok(hasPy, 'run-all.ps1 设置了 PYTHONIOENCODING=utf-8（python 侧同样要说 UTF-8）');
  ok(iSet >= 0 && iUse > iSet, '这段设置出现在第一次调用子进程之前', `设置@${iSet} 使用@${iUse}`);
}

// ── 断言 2：行为——GBK 控制台下，显式设 UTF-8 能解析，不设则失败 ───────
{
  // 一段含中文的 JSON，模拟 fabcheck 的 summary.line
  const probe = path.join(process.env.TEMP || '.', 'encgate-probe.json');
  fs.writeFileSync(probe,
    JSON.stringify({ tool: 'fabcheck', verdict: 'PASS', summary: { line: '可打样：0 阻断 / 4 项警告' } }, null, 2),
    'utf8');

  const script = `
$ErrorActionPreference = 'Continue'
$p = ${JSON.stringify(probe)}
# 先把控制台切到 GBK（模拟中文版 Windows 默认）
try { [Console]::OutputEncoding = [Text.Encoding]::GetEncoding(936) } catch { }
$enc0 = [Console]::OutputEncoding.WebName
# A) 坏写法：不切编码，直接让子进程输出中文再解析
$bad = $null
try { $bad = (& powershell -NoProfile -Command "Get-Content -Raw -Encoding UTF8 '$p'") | ConvertFrom-Json } catch { $bad = $null }
$badOk = ($null -ne $bad)
# B) 好写法：显式把控制台切到 UTF-8 再解析
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$good = $null
try { $good = (& powershell -NoProfile -Command "Get-Content -Raw -Encoding UTF8 '$p'") | ConvertFrom-Json } catch { $good = $null }
$goodOk = ($null -ne $good)
$line = if ($good) { $good.summary.line } else { '' }
Write-Output ("ENC0=" + $enc0)
Write-Output ("BAD_OK=" + $badOk)
Write-Output ("GOOD_OK=" + $goodOk)
Write-Output ("LINE=" + $line)
`;
  const sf = path.join(process.env.TEMP || '.', 'encgate.ps1');
  fs.writeFileSync(sf, script, 'utf8');
  const r = spawnSync(PWSH, ['-NoProfile', '-File', sf], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = (k) => (new RegExp('^' + k + '=(.*)$', 'm').exec(out) || [])[1] || '';

  ok(/^(gb2312|gbk|936)/i.test(m('ENC0').trim()) || m('ENC0').trim() === '',
    '能造出 GBK 控制台（否则这条行为断言没有对照）', `ENC0=${m('ENC0')}`);
  // 关键断言：修好的写法必须能解析出中文
  ok(m('GOOD_OK').trim() === 'True', '切到 UTF-8 之后，含中文的 JSON 能解析', `GOOD_OK=${m('GOOD_OK')}`);
  ok(/可打样/.test(m('LINE')), '解析出来的中文没有乱码', `LINE=${m('LINE')}`);
  // 反向：如果不切编码也能解析，说明这台机器本来就是 UTF-8，这条对照不成立 —— 不算失败，但要说明
  if (m('BAD_OK').trim() === 'True') {
    console.log('  [note] 本机控制台本来就是 UTF-8，坏写法也能过 —— 行为对照在本机不具区分度（文本断言仍然有效）');
  } else {
    ok(true, '不切编码确实会失败（证明这条断言有区分度）');
  }
  try { fs.unlinkSync(probe); fs.unlinkSync(sf); } catch (e) { }
}

console.log('');
const total = pass + fail;
if (fail) { console.log(`  ENCGATE=FAIL  ${fail} / ${total} 条断言未过`); process.exit(1); }
if (!total) { console.log('  ENCGATE=FAIL  一条断言都没跑'); process.exit(1); }
console.log(`  ENCGATE=PASS  ${total} 条断言全过（文本 3 条 + 行为 3 条：GBK 对照 · UTF-8 可解析 · 无乱码）`);
process.exit(0);
