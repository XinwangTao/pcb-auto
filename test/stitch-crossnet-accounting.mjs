#!/usr/bin/env node
// 闸门：缝合线（stitchGaps）造出**异网**间距违规时必须撤掉自己；同网贴合必须保留。
//
// 为什么要有这道闸门：
//   `stitchGaps` 建桥之前没有任何间距检查 —— 它只看断点 12mil 内有没有锚点、
//   对面孤岛在不在 MAX_GAP 内，然后直接 create。实测出处
//   （out/ESP32S3_Wireless_Mic_V5-20261126-201359，2026-11-26T20:21:44+08:00）：
//   第 0 轮建了 2 条缝合线（stitchRound {round:0, broken:6, fixed:2}），其中 3V3 那条
//   id=7ecb8a6ae1ff0b40（(729,-1749)→(802,-1720)，gap 79，层 1，w=12）一条线就占了
//   26 个 DRC leaf 里 8 条已诊断 clearDiag 中的 6 条，clearNet 判定全是异网：
//     Track↔Track   n1=3V3 n2=IMU_REGOUT sameNet=False cur=0.000 need=4.016  ← 短路
//     Track↔SMD Pad n1=3V3 n2=GND        sameNet=False cur=2.922 need=5.984
//     Track↔Via     n1=3V3 n2=GND        sameNet=False cur=0.000 need=5.984  ← 短路到地
//   cur=0 不是「间距不够」，是两块铜直接相接。断路可修，短路会烧板。
//
// 为什么要分同网/异网（不能见违规就删）：
//   这块板的 DRC 确实会报**同网**自间距（语料里 Track↔SMD Pad cur=0 出现 49 次），
//   而缝合线的本职就是贴着同网铜把两个孤岛连起来 —— 同网接触不是缺陷，删了就是白断。
//
// 退出码契约：0 通过 / 1 发现失败 / 2 环境问题（读不到源文件、抽取锚点变了、没有 pwsh 才归 2）。
//   凡是 pipeline3.js 的**内容**不满足契约，一律 1。
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'scripts', 'pipeline3.js');

function bail(msg) { console.log('  STITCH-CROSSNET=ENVSKIP  ' + msg); process.exit(2); }
function contractFail(msg) { console.log('  STITCH-CROSSNET=FAIL  ' + msg); process.exit(1); }

let src;
try { src = fs.readFileSync(SRC, 'utf8'); }
catch (e) { bail(`读不到 ${path.relative(ROOT, SRC)}：${e.message}`); }

// ── 抽取：两个唯一锚点之间的那段（就是我加进 stitchGaps 的复检块）──────────────
const START = '    if (stitchedIds.size) {';
const ENDMARK = '    if (!broken.length) { log(\'stitchDone\', { round, remaining: 0 }); break; }';
const a = src.indexOf(START);
if (a < 0) contractFail('找不到起锚点 `if (stitchedIds.size) {` —— 缝合线的异网复检块不在了（契约要求它必须存在）');
if (src.indexOf(START, a + 1) >= 0) contractFail('起锚点出现多次，无法确定抽哪一段');
const b = src.indexOf(ENDMARK, a);
if (b < 0) contractFail(`找不到止锚点：${ENDMARK}`);
if (b <= a) contractFail('抽取区间为空');
const block = src.slice(a, b);
for (const needle of ['Clearance Error', 'stitchReverted', 'stitchKept', '=== true', 'readSide']) {
  if (!block.includes(needle)) contractFail(`抽到的块里没有 ${needle} —— 抽错段了，闸门在验空气`);
}

// ── 抽取：E3 的状态声明（stitchedIds / stitchNetById / 两个计数器）──────────────
const E3A = 'let stitchRevertCount = 0;';
const E3B = 'const stitchNetById = new Map();';
const e3a = src.indexOf(E3A);
if (e3a < 0) contractFail('找不到 `let stitchRevertCount = 0;` —— 缝合撤回计数器不在了');
if (src.indexOf(E3A, e3a + 1) >= 0) contractFail('E3 起锚点出现多次');
const e3b = src.indexOf(E3B, e3a);
if (e3b < 0) contractFail('找不到 `const stitchNetById = new Map();`');
const e3 = src.slice(e3a, e3b + E3B.length);

// ── 抽取：提到顶层的 objIdOf / pickApi / readSide（要测真的，不打桩）────────────
function sliceBalanced(text, from) {
  let i = text.indexOf('{', from);
  if (i < 0) return null;
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); if (i < 0) return null; continue; }
    if (c === '/' && text[i + 1] === '*') { const j = text.indexOf('*/', i + 2); if (j < 0) return null; i = j + 1; continue; }
    if (c === '\'' || c === '"' || c === '`') {
      const q = c; i++;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === q) break;
        i++;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(from, i + 1); }
  }
  return null;
}
function grabFn(header) {
  const at = src.indexOf(header);
  if (at < 0) contractFail(`找不到函数声明：${header}`);
  if (src.indexOf(header, at + 1) >= 0) contractFail(`函数声明出现多次：${header}`);
  const seg = sliceBalanced(src, at);
  if (!seg) contractFail(`无法用括号配平切出 ${header}`);
  return seg;
}
const OBJID = grabFn('function objIdOf(x) {');
const PICK = grabFn('function pickApi(ty) {');
const READ = grabFn('async function readSide(ty, id) {');

// 三个函数各只允许一份定义 —— 复制实现必然漂移（AGENTS.md 明令禁止）
for (const [sig, label] of [['function objIdOf(x) {', 'objIdOf'], ['function pickApi(ty) {', 'pickApi'],
  ['async function readSide(ty, id) {', 'readSide']]) {
  const n = src.split(sig).length - 1;
  if (n !== 1) contractFail(`${label} 的定义应恰好 1 处，实际 ${n} 处 —— 不许复制实现`);
  if (src.includes(`const ${label} = `)) contractFail(`${label} 还留着旧的局部实现（必须只有一份）`);
}

// 建线时必须记 id 与 net，否则下一轮复检没有输入
if (!src.includes('stitchedIds.add(String(mId));')) contractFail('建线成功后没有 stitchedIds.add(String(mId)) —— 复检拿不到输入');
if (!src.includes('stitchNetById.set(String(mId)')) contractFail('建线成功后没有 stitchNetById.set(...) —— 判不了同网/异网');
// 对外数字语义 + 分解账
if (!src.includes("log('stitchedTotal', stitchCount);")) contractFail('对外数字 stitchedTotal 不见了（scripts/inspect-run.js 在读它）');
if (!src.includes("log('stitchRevertTotal'")) contractFail('缺少 stitchRevertTotal 分解账 —— 「建了几条/撤了几条/还剩几条」会互相顶替');

const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;

// 把真实代码拼成一个可调用体：先放三个真函数，再放 E3 声明，最后放复检块。
// ★ E3 只**声明**集合（`const stitchedIds = new Set()`），真正的 add 在 E5 建线成功处。
//   所以测试必须自己把"本轮建过哪几条线"喂进去 —— 否则复检块拿到空集合，
//   它（正确地）什么都不做，而闸门会得到 15 条假红。这个坑本身值得记住：
//   「驱动真实代码」时，被测块的上游输入必须由测试补齐，不然测的是"空输入"。
const bodyParts = [
  'const logLines = [];',
  'const log = (s, v) => logLines.push({ s, v });',
  'let stitchCount = initialCount;',
  e3,
  'for (const [k, v] of stitchNets) { stitchedIds.add(k); stitchNetById.set(k, v); }',
  OBJID,
  PICK,
  READ,
  block,
  'return { logLines, stitchCount, stitchRevertCount, stitchKeptCount,',
  '  ids: [...stitchedIds], nets: [...stitchNetById.entries()],',
  '  reads: readCountRef.n };',
];
const BODY = bodyParts.join('\n');
let RUNNER;
try {
  RUNNER = new AsyncFn('eda', 'details', 'initialCount', 'stitchNets', 'readCountRef', BODY);
} catch (e) {
  bail(`抽取出的代码拼不成可执行体（源码结构变了）：${e.message}`);
}

// 一个"真"的 eda 桩：get 返回的对象形状照抄真实 API（getState_Net/PrimitiveType），
// 未知 id 返回 undefined —— 这正是 readSide 里 `if (!prim) return null` 的失败形态。
function makeEda(netOf, deleteMode) {
  const objFor = (id) => {
    const rec = netOf[id];
    if (!rec) return undefined;
    return {
      getState_PrimitiveType: () => rec.type,
      getState_Net: () => rec.net,
      getState_PadNumber: () => 1,
      getState_Hole: () => ['PTH', 11.8],
      getState_Layer: () => 1,
      getState_LineWidth: () => 12,
    };
  };
  return {
    pcb_PrimitiveLine: { get: async (id) => objFor(id), delete: async () => deleteMode },
    pcb_PrimitiveVia: { get: async (id) => objFor(id) },
    pcb_PrimitivePad: { get: async (id) => objFor(id) },
  };
}

function run({ nets = {}, details = [], initialCount = 1, deleteMode = true }) {
  const readCountRef = { n: 0 };
  const eda = makeEda(nets, deleteMode);
  // 计 readSide 实际调用次数：包一层计数（不改其行为）
  const netOf = nets;
  const origLine = eda.pcb_PrimitiveLine.get;
  const origVia = eda.pcb_PrimitiveVia.get;
  const origPad = eda.pcb_PrimitivePad.get;
  eda.pcb_PrimitiveLine.get = async (id) => { readCountRef.n++; return origLine(id); };
  eda.pcb_PrimitiveVia.get = async (id) => { readCountRef.n++; return origVia(id); };
  eda.pcb_PrimitivePad.get = async (id) => { readCountRef.n++; return origPad(id); };
  const stitchNets = new Map(Object.entries(netOf).filter(([, v]) => v.mine).map(([k, v]) => [k, v.net]));
  return RUNNER(eda, details, initialCount, stitchNets, readCountRef);
}

const clearViol = (obj1Type, obj1, obj2Type, obj2) => ({
  errorType: 'Clearance Error',
  explanation: { errData: { obj1Type, obj1, obj2Type, obj2, minDistance: 0, clearance: 0.598, position: { x: 0, y: 0 } } },
});

let pass = 0;
const fails = [];
const chk = (cond, label) => { if (cond) pass++; else fails.push(label); };

async function main() {
  // ── 1. 异网短路 → 必须删，并且计数要分开记 ───────────────────────────────
  {
    const r = await run({
      nets: { S1: { type: 'LINE', net: '3V3', mine: true }, T1: { type: 'LINE', net: 'IMU_REGOUT' } },
      details: [clearViol('Track', 'S1', 'Track', 'T1')],
      initialCount: 1,
    });
    const rev = r.logLines.find((x) => x.s === 'stitchReverted');
    chk(!!rev, '[cross] 异网短路必须产生 stitchReverted 记录');
    if (!rev) { console.log('    日志: ' + JSON.stringify(r.logLines)); }
    chk(rev && rev.v.deleted === true, '[cross] 删除成功必须记 deleted:true');
    chk(rev && Array.isArray(rev.v.crossNets) && rev.v.crossNets.includes('IMU_REGOUT'),
      '[cross] 必须记下对方网络名（只有"删了 1 个"读者无法复核）');
    chk(rev && /短路会烧板/.test(String(rev.v.why)), '[cross] 必须写明取舍：断路可修、短路会烧板');
    chk(r.stitchCount === 0, `[cross] 删掉后 onBoard 必须减到 0，实际 ${r.stitchCount}`);
    chk(r.stitchRevertCount === 1, `[cross] stitchRevertCount 必须为 1，实际 ${r.stitchRevertCount}`);
    chk(!r.logLines.some((x) => x.s === 'stitchKept'), '[cross] 异网不该同时记成"保留"');
  }

  // ── 2. 同网贴合 → 必须保留（删了就是白断一条本来就该连的线）────────────────
  {
    const r = await run({
      nets: { S1: { type: 'LINE', net: '3V3', mine: true }, T1: { type: 'PAD', net: '3V3' } },
      details: [clearViol('Track', 'S1', 'SMD Pad', 'T1')],
      initialCount: 1,
    });
    const kept = r.logLines.find((x) => x.s === 'stitchKept');
    chk(!!kept, '[same] 同网违规必须产生 stitchKept 记录');
    chk(!r.logLines.some((x) => x.s === 'stitchReverted'), '[same] 同网不许删（缝合线的本职就是贴着同网铜）');
    chk(r.stitchCount === 1, `[same] onBoard 必须保持 1，实际 ${r.stitchCount}`);
    chk(r.stitchKeptCount === 1, `[same] stitchKeptCount 必须为 1，实际 ${r.stitchKeptCount}`);
  }

  // ── 3. 对方网络读不到 → 保留但记 unknown（不知道 ≠ 不同网；误删不可逆）──────
  {
    const r = await run({
      nets: { S1: { type: 'LINE', net: '3V3', mine: true } },   // T1 不在表里 ⇒ get 返回 undefined
      details: [clearViol('Track', 'S1', 'Hole', 'T1')],
      initialCount: 1,
    });
    const kept = r.logLines.find((x) => x.s === 'stitchKept');
    chk(!!kept, '[unknown] 对方网络不可读时必须记 stitchKept');
    chk(kept && kept.v.unknown >= 1, '[unknown] 必须把"读不到"记进 unknown，不许静默当成同网');
    chk(!r.logLines.some((x) => x.s === 'stitchReverted'), '[unknown] 不知道时不许删');
    chk(r.stitchCount === 1, '[unknown] onBoard 保持 1');
  }

  // ── 4. delete 返回 false（不抛）→ 不许当成"删掉了" ────────────────────────
  {
    const r = await run({
      nets: { S1: { type: 'LINE', net: '3V3', mine: true }, T1: { type: 'VIA', net: 'GND' } },
      details: [clearViol('Track', 'S1', 'Via', 'T1')],
      initialCount: 1, deleteMode: false,
    });
    const rev = r.logLines.find((x) => x.s === 'stitchReverted');
    chk(!!rev, '[delfail] 即使删除失败也必须留下 attempt 记录');
    chk(rev && rev.v.deleted === false, '[delfail] delete 返回 false 必须记 deleted:false（它 resolve(false) 而不抛）');
    chk(r.stitchCount === 1, `[delfail] 删除失败时 onBoard 不许减少，实际 ${r.stitchCount}`);
    chk(r.stitchRevertCount === 0, '[delfail] 删除失败不计入已撤回');
  }

  // ── 5. 两条线一异网一同网 → 只删那条异网的 ────────────────────────────────
  {
    const r = await run({
      nets: { S1: { type: 'LINE', net: '3V3', mine: true }, T1: { type: 'LINE', net: 'IMU_REGOUT' },
        S2: { type: 'LINE', net: 'GND', mine: true }, T2: { type: 'LINE', net: 'GND' } },
      details: [clearViol('Track', 'S1', 'Track', 'T1'), clearViol('Track', 'S2', 'Track', 'T2')],
      initialCount: 2,
    });
    const revIds = r.logLines.filter((x) => x.s === 'stitchReverted').map((x) => x.v.id);
    const keptIds = r.logLines.filter((x) => x.s === 'stitchKept').map((x) => x.v.id);
    chk(revIds.length === 1 && revIds[0] === 'S1', `[mixed] 只该撤 S1，实际撤了 ${JSON.stringify(revIds)}`);
    chk(keptIds.includes('S2'), '[mixed] S2 同网必须保留');
    chk(r.stitchCount === 1, `[mixed] onBoard 应为 1，实际 ${r.stitchCount}`);
  }

  // ── 6. 没有缝合线时不读任何东西（守卫在空集合上必须零代价）─────────────────
  {
    const r = await run({ nets: {}, details: [clearViol('Track', 'X', 'Track', 'Y')], initialCount: 0 });
    chk(r.logLines.length === 0, `[empty] 空集合不该产生任何日志，实际 ${JSON.stringify(r.logLines)}`);
    chk(r.reads === 0, `[empty] 空集合不该调用任何 get（零代价），实际 ${r.reads} 次`);
  }

  // ── 7. 与本块无关的违规（两侧都不是我建的线）不许被算进来 ──────────────────
  {
    const r = await run({
      nets: { A: { type: 'LINE', net: '3V3' }, T1: { type: 'LINE', net: 'GND' } },
      details: [clearViol('Track', 'A', 'Track', 'T1')],
      initialCount: 1,
    });
    chk(r.logLines.length === 0, '[unrelated] 与本阶段无关的违规不该产生记录');
    chk(r.stitchCount === 1, '[unrelated] onBoard 不变');
  }

  if (fails.length) {
    console.log(`  STITCH-CROSSNET=FAIL  ${fails.length} 条断言失败（共 ${pass + fails.length}）`);
    for (const f of fails) console.log('    ✗ ' + f);
    process.exit(1);
  }
  console.log(`  STITCH-CROSSNET=PASS  ${pass} 条断言全过（7 个场景：异网撤 · 同网留 · 读不到留 · 删失败不虚报 · 混合 · 空集合零代价 · 无关违规）`);
}

main().catch((e) => {
  console.log('  STITCH-CROSSNET=FAIL  运行期异常：' + (e && e.stack || e));
  process.exit(1);
});
