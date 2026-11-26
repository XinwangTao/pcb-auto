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

const ROOT = path.resolve(__dirname, '..');
const CLI = 'E:\\APP\\lceda-pro\\lceda-pro.exe';
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

// 【passed 必须与 total 交叉校验】pcb_Drc.check 在"覆铜刚重建完"的异步窗口里
// 会返回 true 而明细非空（本文件开头已承认这个窗口存在）。只信 passed 就会
// "有违规但 exit 0"。两个信号必须同时成立才算通过；不自洽时宁可判不通过。
const total = items.length;
const consistent = passed ? (itemsErr === null && total === 0) : true;
return {
  ok: true,
  passed: (passed && consistent),
  passedRaw: passed,
  consistent,
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
console.log(JSON.stringify({
  ok: true,
  passed: v.passed,
  projectUuid: v.projectUuid,
  pcbUuid: v.pcbUuid,
  pcbName: v.pcbName,
  boardCount: v.boardCount,
  allPcbs: v.allPcbs,
  total: v.total,
  byType: v.byType,
  byObjType: v.byObjType,
  items: v.items,
  // 【退出码的依据必须留在 JSON 里】L211 用 `v.consistent === false` 决定 exit 2，
  // 但这两个字段原来没被打印 —— 调用方只看到 exit≠0 和一份"total 为 0/缺失"的 JSON，
  // 于是 run-all 打印出「独立 DRC 复核失败：0 处违规」，一个自相矛盾的结论。
  consistent: v.consistent,
  itemsErr: v.itemsErr,
}, null, 2));

// 【退出码必须区分"板子有违规"与"根本没查成"】
// 文件头约定：0=通过 1=有违规 2=环境错误。但 `openTarget()` 找不到同时有
// 原理图页和 PCB 的板时 return { ok:false, error:'no board…' }，这个对象若落进
// env.value，`v.passed` 就是 undefined → exit 1 → run-all.ps1 打印
// "独立 DRC 复核失败：（流水线自述通过 = 假阴性）"，把**环境故障记成设计缺陷**，
// 还会白烧一整轮 590s 去换板框。同理 passed 与 total 不自洽也不是"有违规"。
if (!env.value || env.value.ok === false) {
  console.error('独立 DRC 未能执行（环境/工程问题）：' + JSON.stringify(env.value || env, null, 2).slice(0, 1200));
  process.exit(2);
}
process.exit(v.passed === true ? 0 : (v.consistent === false ? 2 : 1));
