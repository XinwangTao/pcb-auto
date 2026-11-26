/**
 * 展开 DRC 分组树，看清到底哪几个焊盘/网络断连。
 *
 * 背景：`pcb_Drc.check(true,false,true)` 返回的是**分组树**，
 * 顶层数组长度是「错误类别数」而不是错误总数。之前 _run.json 里
 * 「DRC 违规组数 1」就是这个类别数，看起来像只有 1 个问题，
 * 实际组内可能有 N 个具体断点 —— 不展开就无法定位。
 *
 * 用法：node diag-drc-deep.js <out目录名> <sessionId>
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CLI = 'E:\\APP\\lceda-pro\\lceda-pro.exe';

const dirName = process.argv[2];
const session = process.argv[3];
if (!dirName) {
  console.error('用法: node diag-drc-deep.js <out目录名> [sessionId]');
  process.exit(2);
}
const runJson = path.join(ROOT, 'out', dirName, '_run.json');
if (!fs.existsSync(runJson)) {
  console.error(`找不到 ${runJson}`);
  process.exit(2);
}
const uuid = JSON.parse(fs.readFileSync(runJson, 'utf8')).projectUuid;

const body = `
const A = __CLI__.args;
await eda.dmt_Project.openProject(A.uuid);
await new Promise(r => setTimeout(r, 2500));
const pcbs = await eda.dmt_Pcb.getAllPcbsInfo();
const pcb = (pcbs || [])[0];
if (!pcb) return { error: 'no pcb' };
await eda.dmt_EditorControl.openDocument(pcb.uuid);
await eda.dmt_EditorControl.waitForDocumentReady(pcb.uuid, 60000);
await new Promise(r => setTimeout(r, 1500));

const groups = await eda.pcb_Drc.check(true, false, true);

// 递归展开：分组树每层可能是 {title, children} 或字符串
function walk(node, depth, out) {
  if (node == null) return;
  if (typeof node === 'string') { out.push({ depth, text: node }); return; }
  if (Array.isArray(node)) { for (const n of node) walk(n, depth, out); return; }
  const title = node.title ?? node.name ?? node.type ?? node.rule;
  const extra = {};
  for (const k of Object.keys(node)) {
    if (k === 'children' || k === 'items' || k === 'subItems' || k === 'title') continue;
    const v = node[k];
    if (v == null) continue;
    if (typeof v === 'object') continue;
    extra[k] = v;
  }
  out.push({ depth, title, ...extra });
  for (const key of ['children', 'items', 'subItems']) {
    if (Array.isArray(node[key])) walk(node[key], depth + 1, out);
  }
}

const flat = [];
walk(groups, 0, flat);

// 统计真正的叶子（最深层节点）数量
const maxDepth = flat.reduce((m, x) => Math.max(m, x.depth), 0);
const leaves = flat.filter(x => x.depth === maxDepth);

return {
  pcbName: pcb.name,
  passed: await eda.pcb_Drc.check(true, false, false),
  groupCount: Array.isArray(groups) ? groups.length : 0,
  maxDepth,
  leafCount: leaves.length,
  tree: flat.slice(0, 60),
};
`;

const tmp = path.join(ROOT, 'scripts', '_diag_drc_deep.js');
fs.writeFileSync(tmp, body, 'utf8');
const args = ['invoke', '--code-file', tmp, '--args', JSON.stringify({ uuid })];
if (session) args.push('--session', session);
const r = spawnSync(CLI, args, {
  cwd: ROOT, encoding: 'utf8', timeout: 300000,
  maxBuffer: 32 * 1024 * 1024, windowsHide: true,
});
console.log((r.stdout || '').slice(0, 14000));
if (r.stderr) console.log('--- stderr ---\n' + r.stderr.slice(0, 3000));
fs.unlinkSync(tmp);
