#!/usr/bin/env node
/**
 * scripts/preflight.mjs · 换一台机器时，先跑这一条
 *
 * 为什么需要它
 * ------------
 * 2026-11-27 在一台干净的 Windows 上部署，前四次尝试全部失败，而**四个原因都只有装完
 * 才知道**（详见 out/_probe/INSTALL-ON-ANOTHER-MACHINE.md）：
 *
 *   1. 只 `git clone` 没 `npm install` ⇒ `staticcheck` 报「解析器不可用，本关跳过」，
 *      **契约闸门静默关闭**（现在依赖已声明为 devDependencies，但那一句 npm install 没人提醒）
 *   2. 仓库装在该机写不进去的分区 ⇒ 六个导出全 `ok:false` 却各自带着真实 size，
 *      跑满 336 秒、产物目录只剩几个文件
 *   3. 该机**没有 WMIC** ⇒ `open --headless true` 报 `SPAWN_OWNER_FAILED`，
 *      必须先手动起一次客户端
 *   4. 中文版 Windows 的控制台是 GBK ⇒ 子进程中文 JSON 解析失败，
 *      报成「fabcheck exit=0，输出不是 JSON」（run-all 已自动切 UTF-8，但别的调用方不一定）
 *
 * 这四个都不该靠读文档发现。所以这里把它们变成一条命令的输出。
 *
 * 退出码：0 = 可以跑；1 = 有阻塞项（必须修）；2 = 检查器自身跑不起来
 * 警告（WARN）不阻塞 —— 它们是「这台机器上大概率会踩，但也许不会」的项。
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);

const blockers = [];
const warns = [];
const oks = [];

const ok = (m) => oks.push(m);
const warn = (m) => warns.push(m);
const bad = (m) => blockers.push(m);

function tryRun(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
  } catch (e) { return { status: -1, out: String(e && e.message) }; }
}

// ── 1. Node ────────────────────────────────────────────────────────────
{
  const need = [18, 17, 0];
  const cur = process.versions.node.split('.').map(Number);
  const okv = cur[0] > need[0] || (cur[0] === need[0] && (cur[1] > need[1] || (cur[1] === need[1] && cur[2] >= need[2])));
  if (okv) ok(`Node ${process.versions.node}`);
  else bad(`Node ${process.versions.node} 太旧，需要 >= 18.17（package.json 的 engines 就是这么写的）`);
}

// ── 2. npm install 有没有真跑过（这是「契约闸门静默关闭」的那个坑）─────────
{
  const miss = [];
  for (const m of ['acorn', 'eslint-scope']) {
    try { require.resolve(m); } catch (_) { miss.push(m); }
  }
  if (miss.length === 0) ok('acorn / eslint-scope 可用（契约闸门能跑）');
  else bad(`缺 ${miss.join(', ')} ⇒ 在仓库根跑一次 \`npm install\`。`
    + `\n         不装的话 scripts/staticcheck.js 会退 2「解析器不可用，本关跳过」——`
    + `\n         那意味着「返回对象引用了不可见标识符」这类闸门**静默关闭**，而没有任何一处会红。`);
}

// ── 3. pwsh 7（run-all.ps1 的宿主）──────────────────────────────────────
const PWSH = (() => {
  for (const c of [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    'pwsh.exe',
  ]) {
    const r = tryRun(c, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major']);
    if (r.status === 0) return c;
  }
  return null;
})();
if (PWSH) {
  const v = tryRun(PWSH, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']);
  ok(`pwsh ${v.out.trim()} @ ${PWSH}`);
} else {
  bad('找不到 pwsh 7。run-all.ps1 与多数闸门要它：winget install Microsoft.PowerShell');
}

// ── 4. git（三个闸门靠它枚举文件，缺了会退 2）────────────────────────────
{
  const r = tryRun('git', ['--version']);
  if (r.status === 0) ok(r.out.trim());
  else bad('找不到 git。syntax-gate / dev-path-scan / doc-refs 会退 2（拿不到文件清单）');
}

// ── 5. LCEDA（唯一的硬依赖）───────────────────────────────────────────
{
  const cands = [];
  if (process.env.PCB_AUTO_LCEDA) cands.push(process.env.PCB_AUTO_LCEDA);
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  cands.push(path.join(pf, 'lceda-pro', 'lceda-pro.exe'));
  cands.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'lceda-pro', 'lceda-pro.exe'));
  const found = cands.find((p) => p && fs.existsSync(p));
  const onPath = (() => {
    for (const d of (process.env.PATH || '').split(path.delimiter)) {
      const p = path.join(d, 'lceda-pro.exe');
      try { if (fs.existsSync(p)) return p; } catch (_) { }
    }
    return null;
  })();
  const exe = found || onPath;
  if (exe) {
    ok(`LCEDA 找到：${exe}`);
    // 版本目录名里通常带版本号，读不到就跳过（不猜）
    const m = /(\d+\.\d+\.\d+)/.exec(exe);
    if (m && m[1] !== '4.1.111') warn(`版本号看起来是 ${m[1]}，本项目只在 4.1.111 上验证过`);
  } else {
    bad('找不到 lceda-pro.exe。设环境变量 PCB_AUTO_LCEDA 指到它（本项目只支持 4.1.111），'
      + `\n         或把它加到 PATH。试过：${cands.filter(Boolean).join(' / ')}`);
  }
}

// ── 6. WMIC（没有它 headless 会起不来，而报错信息不会告诉你该手动起客户端）──
{
  const wmic = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wbem', 'WMIC.exe');
  if (fs.existsSync(wmic)) ok('WMIC 在（headless 会话能自己拉起来）');
  else warn('**没有 WMIC** ⇒ `lceda-pro open --headless true` 会报 SPAWN_OWNER_FAILED。\n'
    + '          绕过办法：先手动起一次客户端，再开 headless。\n'
    + '            Start-Process lceda-pro.exe ; Start-Sleep 25\n'
    + '            lceda-pro.exe open --headless true        # 把返回的 sessionId 写进 .session');
}

// ── 7. 控制台编码（GBK 会把子进程的中文 JSON 弄坏）──────────────────────
if (PWSH) {
  const r = tryRun(PWSH, ['-NoProfile', '-Command', '[Console]::OutputEncoding.WebName']);
  const enc = r.out.trim().toLowerCase();
  if (/utf-?8|65001/.test(enc)) ok(`控制台编码 ${enc}`);
  else warn(`控制台编码是 ${enc || '未知'}。\n`
    + '          触发条件不是「中文版 Windows」本身，而是**进程没有附加控制台或输出被重定向**时，\n'
    + '          PowerShell 落到系统 ANSI 代码页（中文版是 936）。实测同一台机器：\n'
    + '            交互会话里 [Console]::OutputEncoding = utf-8/65001（所以作者机器看不见）\n'
    + '            从 node 的 spawn 里起子进程 = gb2312/936（所以远端必焦）\n'
    + '          run-all.ps1 会自己切到 UTF-8，但你写在别处的 PowerShell 调用不一定 ——\n'
    + '          表现是「子进程明明输出了 JSON，ConvertFrom-Json 却报 unexpected character」。');
}

// ── 8. 仓库位置（EDA 写盘白名单是机器相关的，这条只能提醒）───────────────
{
  // 只要路径里有一层 Documents 就算：不少机器把用户目录放在非系统盘，
  // 用 os.homedir() 去拼会误报（实测：仓库在 D:\...\Documents\...，而 homedir 在 C:）。
  const under = /[\\/]Documents[\\/]/i.test(ROOT + path.sep);
  if (under) ok(`仓库在一层 Documents 下（多数机器上 EDA 能写这里）`);
  else warn(`仓库不在 Documents 下：${ROOT}\n`
    + '          EDA 的 saveFileToFileSystem 有一个**不写在文档里的可写白名单**，各机器不一样。\n'
    + '          症状：六个导出全 ok:false 却各自带着真实 size，产物目录只剩几个文件。\n'
    + '          实测：本机 D:/F: 可写、C:/E: 不可；另一台 D: 不可、Documents 可。\n'
    + '          踩到就把仓库（或 -OutDir）挪到 Documents 下 —— 开工前的写盘探针会 5 秒内告诉你是这一类。');
}

// ── 9. 有没有别人在跑 ──────────────────────────────────────────────────
{
  const lock = path.join(ROOT, '.pipeline.lock');
  if (fs.existsSync(lock)) {
    const txt = fs.readFileSync(lock, 'utf8').trim();
    warn(`.pipeline.lock 存在（可能有人正在跑）：${txt.replace(/\s+/g, ' ')}`);
  } else ok('没有 .pipeline.lock');
}

// ── 10. python（可选，部分脚本用）────────────────────────────────────────
{
  const py = process.env.PCB_AUTO_PYTHON || 'python';
  const r = tryRun(py, ['--version']);
  if (r.status === 0) ok(r.out.trim());
  else warn('找不到 python（可选：只有部分辅助脚本用；跑主流水线不需要）');
}

// ── 输出 ───────────────────────────────────────────────────────────────
console.log('');
console.log('  ── 部署前置检查 ──');
for (const s of oks) console.log(`  ✓ ${s}`);
for (const s of warns) console.log(`  ! ${s}`);
for (const s of blockers) console.log(`  ✗ ${s}`);
console.log('');
if (blockers.length) {
  console.log(`  PREFLIGHT=BLOCKED  ${blockers.length} 个阻塞项 / ${warns.length} 个提醒 —— 修完再跑。`);
  process.exit(1);
}
console.log(`  PREFLIGHT=OK  没有阻塞项（${oks.length} 项通过 / ${warns.length} 个提醒）`);
process.exit(0);
