/**
 * 诊断某个已生成工程的真实 DRC 违规明细。
 *
 * 用法：
 *   node diag-drc.js <projectUuid|工程目录名> [sessionId]
 *
 * 目的：`_run.json` 只给「DRC 违规组数 1」，看不到到底违反哪条规则、
 * 在哪个对象上。修复必须先知道这个。
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CLI = process.env.PCB_AUTO_LCEDA || process.env.LCEDA;
if (!CLI) {
  console.error('找不到 lceda-pro.exe。设置 PCB_AUTO_LCEDA 指向它（本项目只支持 4.1.111）。');
  process.exit(2);
}

const target = process.argv[2];
if (!target) {
  console.error('用法: node diag-drc.js <projectUuid|工程目录名> [sessionId]');
  process.exit(2);
}

// 找工程 uuid：可以直接传，也可以从 out/<目录>/_run.json 读
let uuid = target;
if (!/^[0-9a-f]{64}$/i.test(target)) {
  const runJson = path.join(ROOT, 'out', target, '_run.json');
  if (!fs.existsSync(runJson)) {
    console.error(`找不到 ${runJson}`);
    process.exit(2);
  }
  uuid = JSON.parse(fs.readFileSync(runJson, 'utf8')).projectUuid;
}
console.log('projectUuid =', uuid);

const body = `
const A = __CLI__.args;
// 正确顺序（pipeline3.js L152 同款）：先 openProject，再取 PCB 文档 uuid 打开，
// 最后 waitForDocumentReady —— 少了 ready 等待，DRC 读的是空画布。
await eda.dmt_Project.openProject(A.uuid);
await new Promise(r => setTimeout(r, 2500));

const pcbs = await eda.dmt_Pcb.getAllPcbsInfo();
const pcb = (pcbs || [])[0];
if (!pcb) return { error: 'no pcb in project', pcbs: pcbs };
await eda.dmt_EditorControl.openDocument(pcb.uuid);
await eda.dmt_EditorControl.waitForDocumentReady(pcb.uuid, 60000);
await new Promise(r => setTimeout(r, 1500));

// 板框尺寸
let bw = null, bh = null;
try {
  const ids = await eda.pcb_PrimitivePolyline.getAllPrimitiveId();
  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
  for (const id of ids || []) {
    const pl = await eda.pcb_PrimitivePolyline.get(id);
    if (pl?.getState_Layer?.() !== 11) continue;
    const poly = pl.getState_Polygon?.();
    if (!poly) continue;
    for (const p of (poly.getPolygon?.() || [])) {
      xMin = Math.min(xMin, p.x); xMax = Math.max(xMax, p.x);
      yMin = Math.min(yMin, p.y); yMax = Math.max(yMax, p.y);
    }
  }
  if (Number.isFinite(xMin)) { bw = Math.round(xMax - xMin); bh = Math.round(yMax - yMin); }
} catch (e) {}

// 完整 DRC 明细
const details = await eda.pcb_Drc.check(true, false, true);
const passed = await eda.pcb_Drc.check(true, false, false);

// 按规则聚合
const byRule = {};
for (const v of (details || [])) {
  const rule = v?.rule || v?.type || 'unknown';
  byRule[rule] = (byRule[rule] || 0) + 1;
}

return {
  pcbName: pcb.name,
  board: [bw, bh],
  passed,
  total: (details || []).length,
  byRule,
  // 只回前 12 条明细，避免输出过大
  samples: (details || []).slice(0, 12).map(v => ({
    rule: v?.rule, type: v?.type, title: v?.title,
    desc: (v?.description || v?.desc || '').slice(0, 200),
    net: v?.net, layer: v?.layer,
  })),
};
`;

const tmp = path.join(ROOT, 'scripts', '_diag_drc_body.js');
fs.writeFileSync(tmp, body, 'utf8');

const args = ['invoke', '--code-file', tmp, '--args', JSON.stringify({ uuid })];
if (process.argv[3]) args.push('--session', process.argv[3]);

const r = spawnSync(CLI, args, {
  cwd: ROOT, encoding: 'utf8', timeout: 300000,
  maxBuffer: 32 * 1024 * 1024, windowsHide: true,
});
console.log('--- stdout ---');
console.log((r.stdout || '').slice(0, 12000));
if (r.stderr) {
  console.log('--- stderr ---');
  console.log(r.stderr.slice(0, 4000));
}
fs.unlinkSync(tmp);
