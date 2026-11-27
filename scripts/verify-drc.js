/**
 * 独立 DRC 复核 —— 不复用流水线结论。
 *
 * 为什么需要它：pipeline3.js 自报的 `drcPassed` 不可信。
 *   - `pcb_PrimitivePour.rebuildAllCopperRegions()` 是**异步**的，
 *     流水线在覆铜未重建完的窗口里判 DRC 会得到假阴性（实测 4 个「失败」里 2 个是这种）
 *   - 工程里可能有多块 PCB（createBoard 重试会多建），
 *     `getAllPcbsInfo()[0]` 未必是流水线在用的那块
 *
 * 本脚本在一个**全新 headless 会话**里打开工程，取 `board.pcb.uuid`
 * （同时有原理图页和 PCB 的那块板），重建覆铜后重查 DRC。
 *
 * 用法：
 *   node verify-drc.js <projectUuid>
 *   node verify-drc.js <projectUuid> <sessionId>     # 复用已有会话
 *
 * 输出（stdout 最后一行）：{ ok, passed, pcbUuid, pcbName, boardCount,
 *                            total, byType, items:[...] }
 * 退出码：0 = DRC 通过；1 = 有违规；2 = 环境错误
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
// 裁定逻辑单独一个纯函数（不碰 EDA / 不碰 fs），让闸门能用构造信封直接测退出码。
const { decide } = require('./drc-verdict.js');

const ROOT = path.resolve(__dirname, '..');
const CLI = process.env.PCB_AUTO_LCEDA || process.env.LCEDA;
if (!CLI) {
  console.error('找不到 lceda-pro.exe。设置 PCB_AUTO_LCEDA 指向它（本项目只支持 4.1.111）。');
  process.exit(2);
}
const projectUuid = process.argv[2];
let session = process.argv[3];

if (!projectUuid) {
  console.error('用法: node verify-drc.js <projectUuid> [sessionId]');
  process.exit(2);
}

// ---------- 内层脚本（跑在 EDA 进程里）----------
const INNER = `
const args = __CLI__.args;
const projectUuid = args.projectUuid;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 递归展平 DRC 分组树。顶层节点只有 name/count/list，**没有 errorType**，
// 真违规是深层叶子 —— 按 errorType 扫顶层会把断点算成 0。
function flatten(node, out) {
  if (!node) return out;
  if (Array.isArray(node)) { node.forEach((n) => flatten(n, out)); return out; }
  if (node.errorType) out.push(node);
  if (node.list) flatten(node.list, out);
  return out;
}

async function openTarget() {
  await eda.dmt_Project.openProject(projectUuid);
  await sleep(3000);
  try { await eda.dmt_Project.waitForReady(projectUuid, 60000); } catch (e) {}

  const boards = (await eda.dmt_Board.getAllBoardsInfo()) || [];
  const board = boards.find((b) => b.schematic?.page?.length && b.pcb);
  if (!board) {
    return { err: 'no board with schematic+pcb', boards: boards.map((b) => b.name) };
  }
  const allPcbs = (await eda.dmt_Pcb.getAllPcbsInfo()) || [];
  const pcbUuid = board.pcb.uuid;

  await eda.dmt_EditorControl.openDocument(pcbUuid);
  await eda.dmt_EditorControl.waitForDocumentReady(pcbUuid, 120000);
  await sleep(2000);

  return { board, allPcbs, pcbUuid, pcbName: board.pcb.name || pcbUuid };
}

const target = await openTarget();
if (target.err) return { ok: false, error: target.err, boards: target.boards };

// 重建覆铜，消掉「覆铜未就绪」造成的假阴性。
// 注意：rebuild 会改内存态，但本脚本**不 save**，所以不落盘、不污染产物。
let rebuilt = false;
try {
  await eda.pcb_PrimitivePour.rebuildAllCopperRegions();
  await sleep(2500);
  rebuilt = true;
} catch (e) { /* 无覆铜的板会抛，忽略 */ }

// 第一次判定
let passed = false;
try { passed = (await eda.pcb_Drc.check(true, false, false)) === true; } catch (e) {}

// 不通过 → 再等一轮重试（异步重建可能还需要时间）
if (!passed) {
  await sleep(1500);
  try { passed = (await eda.pcb_Drc.check(true, false, false)) === true; } catch (e) {}
}

// 取明细
let items = [];
// ★ 取明细失败时 items 也是 []，于是 total:0 与"真的 0 违规"在输出上完全同形。
//   它是**诊断的唯一来源**（byType/byObjType/items 全靠它），不能静默。
let itemsErr = null;
try {
  const detail = await eda.pcb_Drc.check(true, false, true);
  items = flatten(detail, []);
} catch (e) { itemsErr = String((e && e.message) || e).slice(0, 200); }

const byType = {};
const byObjType = {};
for (const it of items) {
  const t = String(it.errorType || 'Unknown');
  byType[t] = (byType[t] || 0) + 1;
  const ot = String(it.errorObjType || '');
  if (ot) byObjType[ot] = (byObjType[ot] || 0) + 1;
}

// 【两个信号原样交出去，裁定交给外层】
// 原来这里就地算了一个 consistent，形状是
//   passed ? (itemsErr === null && total === 0) : true
// —— passed=false 时恒为 true，于是「明细取不到」也走 exit 1（= 有违规）。
// 另一个方向也错：passed=true 但明细非空 ⇒ consistent=false ⇒ exit 2（= 环境异常），
// 【这段在 INNER 模板字符串里，注释里不能出现反引号】——反引号会直接终止模板字符串，
// 于是整个文件变成一个语法错误，而报错指向的是一行看起来无害的注释。
// 2026-11-27 实测踩过（就是这一行）：Synta xError: Unexpected identifier —— 闸门 3 秒拦住。
// 而真相是这块板**确实有违规**。
// 裁定现在在 scripts/drc-verdict.js：哪里有四种组合的完整表与表驱动闸门。
// pcb_Drc.check 在"覆铜刚重建完"的异步窗口里会返回 true 而明细非空（见文件头），
// 所以 passed 与 total **必须都交出去**，任何单独一个都不足以判定。
const total = items.length;
return {
  ok: true,
  // 字段名就叫 passed：它是 DRC API 自己的布尔。裁定结果在外层另取一个名字（passed）。
  passed,
  itemsErr,
  rebuilt,
  projectUuid,
  pcbUuid: target.pcbUuid,
  pcbName: target.pcbName,
  boardCount: (target.allPcbs || []).length,
  allPcbs: (target.allPcbs || []).map((p) => ({ name: p.name, uuid: p.uuid })),
  total: items.length,
  byType,
  byObjType,
  items: items.slice(0, 40).map((it) => {
    const ed = it.explanation?.errData || {};
    return {
      type: it.errorType,
      objType: it.errorObjType,
      rule: it.ruleName,
      net: ed.net,
      o1: ed.obj1Type, o1s: ed.obj1Suffix,
      o2: ed.obj2Type, o2s: ed.obj2Suffix,
      // DRC 坐标是真实画布坐标的 1/10 —— 用前必须 ×10
      pos: ed.position ? { x: ed.position.x, y: ed.position.y } : null,
      minDistance: it.explanation?.param?.minDistance,
      shouldBe: it.explanation?.param?.shouldBe,
    };
  }),
};
`;

// ---------- 调用 CLI ----------
const tmp = path.join(ROOT, 'scripts', `_verify-drc-${process.pid}.js`);
fs.writeFileSync(tmp, INNER, 'utf8');

const args = ['invoke', '--ext-uuid', 'eda', '--code-file', tmp,
  '--args', JSON.stringify({ projectUuid }), '--timeout', '420000'];
if (session) args.push('--session', session);

const r = spawnSync(CLI, args, {
  cwd: ROOT, encoding: 'utf8', timeout: 900000,
  maxBuffer: 64 * 1024 * 1024, windowsHide: true,
});

try { fs.unlinkSync(tmp); } catch (e) {}

const raw = (r.stdout || '').trim();
if (!raw) {
  console.error('CLI 无输出。stderr:\n' + (r.stderr || '').slice(0, 3000));
  process.exit(2);
}

// 取最后一行 JSON（CLI 可能先打别的）
const lines = raw.split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
const last = lines.length ? lines[lines.length - 1] : raw;
let env;
try { env = JSON.parse(last); } catch (e) {
  console.error('无法解析 CLI 输出：\n' + raw.slice(0, 4000));
  process.exit(2);
}

if (!env.ok) {
  console.error(JSON.stringify(env, null, 2));
  process.exit(2);
}

const v = env.value || {};
// 【这一行是唯一的裁定入口】返回 { code, verdict, reason, measured, consistent }
const d = decide(env);

console.log(JSON.stringify({
  ok: true,
  // passed 的含义收紧为「最终裁定是通过」。
  // 原来它是内层的自述，于是 `passed:true` 配 `total:3` 也会打出来，
  // 读的人无法判断到底算不算过。
  passed: (d.verdict === 'clean'),
  verdict: d.verdict,
  verdictReason: d.reason,
  measured: d.measured,
  selfPassed: v.passed,
  projectUuid: v.projectUuid,
  pcbUuid: v.pcbUuid,
  pcbName: v.pcbName,
  boardCount: v.boardCount,
  allPcbs: v.allPcbs,
  total: v.total,
  byType: v.byType,
  byObjType: v.byObjType,
  items: v.items,
  // 【退出码的依据必须留在 JSON 里】曾经只有 exit≠0 加一份
  // "total 为 0/缺失" 的 JSON，调用方只能打出「独立 DRC 复核失败：0 处违规」
  // 这种自相矛盾的结论。现在 verdict/reason/measured 都在这里。
  consistent: d.consistent,
  itemsErr: v.itemsErr,
}, null, 2));

// 【原因要说清楚】且分开两种归类——「查出违规」是一个结论，
// 「没量成」是另一件事，两者的处置完全相反（前者换板框，后者停梯梯）。
if (d.code !== 0) {
  const tag = (d.verdict === 'violations')
    ? '独立 DRC 复核：查出违规'
    : '独立 DRC 复核未能完成（不是设计结论）';
  console.error(tag + ' —— ' + d.verdict + '：' + d.reason);
}
// 退出码：0 = 通过；1 = 有违规（一个结论）；2 = 没量成。三者不能互相顶替。
process.exit(d.code);
