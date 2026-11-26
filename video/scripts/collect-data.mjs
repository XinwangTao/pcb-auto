#!/usr/bin/env node
/**
 * collect-data.mjs — 从 pcb-auto 的真实产物里抽取视频要用的全部数字。
 *
 * 只读 `pcb-auto/out/` 与 `pcb-auto/designs/`；
 * 只写 `video/src/data.json` 与 `video/src/data.PROVENANCE.md`（后者由本脚本生成，勿手改）。
 *
 * ## 输入：四份东西，全部来自**同一个 run 目录**，绝不跨 run 混用
 *
 *   out/<run>/_run.json              板框 / 门禁 / 导出计数 —— 「本次实际生效」的真值
 *   out/<run>/_log.json              事件流（PHASE 累计时间戳、netlist、schDrc、route、pour…）
 *   out/<run>/_design.snapshot.json  这次 run 用的设计（与 designs/<id>.json 同 sha256 才算同一份）
 *   out/<run>/<6 个产物>             真实字节数（statSync 读磁盘，**不信** log 里的 size 字段）
 *
 * 为什么不再读 `logs/<run>.json`：本仓库现在的流水线把日志**落在 run 目录里**
 * （`_log.json`），`logs/` 只是历史遗留。旧版脚本只认 `logs/`，于是新 run 一个都读不到 ——
 * 而 `out/` 会被 `scripts/cleanup.ps1` 滚动清理（保留最新 40 个 + 每个设计名最新 1 个），
 * 钉住的那次 run 早晚会消失。两者叠加就是「文件在、schema 对、指向的东西没了」。
 * 现在：run 目录里的 `_log.json` 是首选，`logs/<run>.json` 只作为老 run 的兜底。
 *
 * ## 为什么钉住一次 run，而不是「最新」
 *
 * 这台机器上的流水线在持续产出新 run，glob「最新」会让视频数字在两次渲染之间漂移，
 * 不可复现。因此 `PINNED_RUN` 显式钉住一个 run；它消失了脚本**退 2 并列出还能用的 run**，
 * 不会静默换成「最新」—— 换了 run，视频里每个数字就不再对得上溯源文档里写的那一次，
 * 而输出看起来完全正常。这是本仓库反复踩的同一类错：**量具读不到输入时不许沉默**。
 *
 * 想换 run 不必改代码：
 *   VIDEO_RUN=<out/ 下的目录名> node scripts/collect-data.mjs
 * 只有显式设成空（VIDEO_RUN= ）才回退到「exportsOk 最高 + 最新」。
 *
 * ## 退出码
 *
 *   0 = 已生成；2 = 输入不全（run 不存在 / 缺产物 / 日志里没有该字段的来源），
 *   没能测量。**任何一条都不是「判据为否」**，是「这次测不了」。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIDEO = path.resolve(__dirname, '..');
const ROOT = path.resolve(VIDEO, '..');
const OUT_ROOT = path.join(ROOT, 'out');
const DESIGN_ROOT = path.join(ROOT, 'designs');

const DATA_DEST = path.join(VIDEO, 'src', 'data.json');
const PROV_DEST = path.join(VIDEO, 'src', 'data.PROVENANCE.md');

/**
 * 钉住的那次 run。
 *
 * 选择规则（2026-11-26 实测，out/ 下 53 个 `_run.json`+`_log.json`+`Gerber.zip` 齐全的目录）：
 * 取 `gates.exportsOk` 最高（全部并列 6/6）里**最新**的一个。
 *
 * 口径提醒：这一次的 `_run.json#ok=false`、`gates.drcPassed=false`、
 * `gates.drcLeafCount=33`、`gates.errors=1`（错料 C7：设计 2.2nF / 实际 2.2pF）。
 * 这些是**真实结果**，不是抽错了 run。详见 data.PROVENANCE.md「本次 run 的口径」。
 * 要一条 DRC 全过的版本：VIDEO_RUN=ESP32C3_Minimal-20261126-084735
 */
const PINNED_RUN = 'ESP32S3_Wireless_Mic_V3-20261126-163653';

/** 一个「完整产物」run 目录必须有的文件（缺一个就不算能出数据）。 */
const RUN_FILES = [
  '_run.json',
  '_log.json',
  'Gerber.zip',
  'Board.pdf',
  'BOM.xlsx',
  'PnP.csv',
  'Netlist.json',
];

// 同步写 stderr：process.exit() 之前用 console.error 在管道上可能丢字。
function die(msg, hints = []) {
  fs.writeSync(2, '[collect-data] 没能开始：' + msg + '\n');
  for (const h of hints) fs.writeSync(2, '               ' + h + '\n');
  process.exit(2); // 2 = 输入/环境不对，没能测量（不是「判据为否」）
}

function readJson(file, why) {
  if (!fs.existsSync(file)) die(`缺 ${path.relative(ROOT, file)}`, [why]);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    die(`${path.relative(ROOT, file)} 解析失败：${e.message}`, [
      '坏 JSON 不能当成「没有这个字段」—— 那会让下游把「读不到」显示成一个正常的数字。',
    ]);
  }
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const iso = (file) => new Date(fs.statSync(file).mtimeMs).toISOString();

/* ─────────────────────────── 1. 选 run ─────────────────────────── */

/** out/ 下「产物齐全」的 run，按 exportsOk 降序、_run.json mtime 降序排列。 */
function completeRuns() {
  if (!fs.existsSync(OUT_ROOT)) {
    die('out/ 不存在', ['视频数据来自一次真实的流水线运行，空仓库里本来就没有。']);
  }
  const rows = [];
  const broken = [];
  for (const name of fs.readdirSync(OUT_ROOT)) {
    const dir = path.join(OUT_ROOT, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const runJson = path.join(dir, '_run.json');
    const logJson = path.join(dir, '_log.json');
    if (!fs.existsSync(runJson) || !fs.existsSync(logJson)) continue;
    if (!fs.existsSync(path.join(dir, 'Gerber.zip'))) continue;
    try {
      const run = JSON.parse(fs.readFileSync(runJson, 'utf8'));
      rows.push({
        name,
        mtime: fs.statSync(runJson).mtimeMs,
        exportsOk: run?.gates?.exportsOk ?? -1,
        exportsTotal: run?.gates?.exportsTotal ?? null,
        ok: run?.ok === true,
        drcLeafCount: run?.gates?.drcLeafCount ?? null,
        elapsedMs: run?.elapsedMs ?? null,
      });
    } catch (e) {
      // 不静默跳过：坏 _run.json 的目录**不算**「不齐全」，它是另一个问题。
      broken.push(`${name}（${e.message}）`);
    }
  }
  if (broken.length) {
    fs.writeSync(2, `[collect-data] 警告：${broken.length} 个目录的 _run.json 解析失败，未计入候选：\n`);
    for (const b of broken) fs.writeSync(2, '               ' + b + '\n');
  }
  return rows.sort((a, b) => b.exportsOk - a.exportsOk || b.mtime - a.mtime);
}

const hasEnv = Object.prototype.hasOwnProperty.call(process.env, 'VIDEO_RUN');
const requested = hasEnv ? process.env.VIDEO_RUN.trim() : PINNED_RUN;
const candidates = completeRuns();

let outName;
if (requested) {
  if (!fs.existsSync(path.join(OUT_ROOT, requested))) {
    // 空克隆里「换一个现存的」是句废话说 —— 一个现存的都没有。别让人照着空话转圈。
    die(`指定的 run 不存在：out/${requested}`, [
      'out/ 会被 cleanup.ps1 自动清理（保留最新 40 个 + 每个设计名最新 1 个），',
      '所以曾经钉住的那次 run 消失是正常的，不是仓库坏了。',
      '',
      ...(candidates.length
        ? [
            '换一个现存的：VIDEO_RUN=<名字> node scripts/collect-data.mjs',
            '或者用默认规则（exportsOk 最高 + 最新）：VIDEO_RUN= node scripts/collect-data.mjs',
            '',
            `产物齐全（_run.json + _log.json + Gerber.zip）的 ${candidates.length} 个 run，按 exportsOk/mtime 排序，前 8 个：`,
            ...candidates
              .slice(0, 8)
              .map(
                (c) =>
                  `  ${c.name}  exportsOk=${c.exportsOk}/${c.exportsTotal}  ok=${c.ok}  ` +
                  `drcLeaf=${c.drcLeafCount}  ${new Date(c.mtime).toISOString()}`,
              ),
            '',
            '注意：换 run 之后，视频里每个数字都来自这一次，不再等于 PINNED_RUN 注释里的那一次。',
          ]
        : [
            '这一个克隆里，产物齐全的 run 一个都没有 —— 所以现在没有东西可指定。',
            '视频数据来自一次真实的流水线运行，空仓库里本来就没有。',
            '',
            '先造一次（需要 PowerShell 7 + 嘉立创 EDA Pro，Windows）：',
            '  node cli/pcb.mjs build designs/mic-esp32s3-v3.json',
            '然后指定它：',
            '  VIDEO_RUN=<out/ 下新出现的目录名> node scripts/collect-data.mjs',
          ]),
    ]);
  }
  outName = requested;
} else {
  if (!candidates.length) {
    die('out/ 下一个产物齐全的 run 都没有', [
      '需要同时有 _run.json + _log.json + Gerber.zip。',
      '先跑一次流水线产出产物，或者用 VIDEO_RUN=<名字> 指定。',
    ]);
  }
  outName = candidates[0].name;
}

const outDir = path.join(OUT_ROOT, outName);
const outDirRel = `out/${outName}`;
const runPath = path.join(outDir, '_run.json');
const logPath = path.join(outDir, '_log.json');
const snapPath = path.join(outDir, '_design.snapshot.json');

const missing = RUN_FILES.filter((f) => !fs.existsSync(path.join(outDir, f)));
if (missing.length) {
  die(`out/${outName} 缺 ${missing.length} 个文件：${missing.join('、')}`, [
    '这几次运行可能没跑到 export 阶段，或者产物被清理了一部分。',
    '换一个产物齐全的 run：VIDEO_RUN=<名字> node scripts/collect-data.mjs',
  ]);
}

/* ─────────────────────── 2. 读三个真值文件 ─────────────────────── */

const run = readJson(runPath, '_run.json 是板框与门禁计数的唯一来源。');
const gates = run.gates || {};
const logDoc = readJson(logPath, '_log.json 是阶段耗时 / netlist / DRC 明细的唯一来源。');

// 事件流：新 run 在 _log.json#entries；老 run 在 logs/<name>.json#value.log。
// 两者都认，但**必须**说清楚读的是哪一个（写进 _provenance）。
let events;
let logSource;
if (Array.isArray(logDoc.entries)) {
  events = logDoc.entries;
  logSource = '_log.json#entries';
} else if (Array.isArray(logDoc?.value?.log)) {
  events = logDoc.value.log;
  logSource = `logs/${outName}.json#value.log`;
} else {
  die('日志里既没有 entries[] 也没有 value.log[] —— 阶段/网络/DRC 一个都没有来源', [
    '不知道这份日志是哪一版流水线写的。换一个 run，或者先修日志格式。',
  ]);
}

const pick = (stage) => {
  const e = events.find((x) => x && x.s === stage);
  return e ? e.v : null;
};

/** 从事件里取一个「数字」字段；事件不存在 → null（调用方负责写进 PROVENANCE 的缺失清单）。 */
function numberField(stage, key) {
  const v = pick(stage);
  if (v == null) return null;
  if (typeof v === 'number') return v;
  return typeof v?.[key] === 'number' ? v[key] : null;
}

/* ── 2a. 设计：优先 run 目录里的快照，回退 designs/ 下同名文件 ── */

const designName = String(run.designName || '');
if (!designName) die('_run.json 里没有 designName —— 不知道该读哪份设计');

/** designs/ 下 name 匹配的那份设计（文件名 → 供画面显示 designs/<id>.json）。 */
function findDesignByName(name) {
  if (!fs.existsSync(DESIGN_ROOT)) return null;
  const bad = [];
  for (const f of fs.readdirSync(DESIGN_ROOT)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const abs = path.join(DESIGN_ROOT, f);
    try {
      if (JSON.parse(fs.readFileSync(abs, 'utf8')).name === name) {
        return { rel: `designs/${f}`, id: f.replace(/\.json$/, ''), abs };
      }
    } catch (e) {
      bad.push(`${f}（${e.message}）`);
    }
  }
  if (bad.length) {
    fs.writeSync(2, `[collect-data] 警告：designs/ 下 ${bad.length} 个 JSON 解析失败，未参与匹配：\n`);
    for (const b of bad) fs.writeSync(2, '               ' + b + '\n');
  }
  return null;
}

const designFile = findDesignByName(designName);
let design;
let designPath;
if (fs.existsSync(snapPath)) {
  design = readJson(snapPath, '快照是这次 run 实际用的那一份设计。');
  designPath = snapPath;
  if (design.name !== designName) {
    die(`快照里的 name 与 _run.json 不一致：${design.name} ≠ ${designName}`, [
      '_design.snapshot.json 与 _run.json 必须是同一次运行的两面。',
    ]);
  }
  if (designFile && sha256(snapPath) !== sha256(designFile.abs)) {
    fs.writeSync(
      2,
      `[collect-data] 警告：_design.snapshot.json 与 ${designFile.rel} 内容不同` +
        '（快照是那次 run 的真实输入，本脚本以快照为准）。\n',
    );
  }
} else if (designFile) {
  design = readJson(designFile.abs, '快照缺失时用 designs/ 下同名设计兜底。');
  designPath = designFile.abs;
  fs.writeSync(
    2,
    '[collect-data] 警告：run 目录里没有 _design.snapshot.json，回退到 ' +
      `${designFile.rel}（两者可能已经漂移）。\n`,
  );
} else {
  die(`既没有 _design.snapshot.json，designs/ 下也没有 name="${designName}" 的设计`, [
    '没有设计就没有想法原文 / 器件表 / 连接数。',
  ]);
}

const components = (Array.isArray(design.components) ? design.components : []).map((c) => ({
  des: c.des,
  lcsc: c.lcsc,
  value: c.value,
}));
if (!components.length) die(`设计 ${designName} 的 components[] 是空的`);
if (!Array.isArray(design.connections)) die(`设计 ${designName} 没有 connections[]`);

/* ── 2b. 阶段耗时（PHASE 是**累计**毫秒，差分得单阶段耗时） ── */

const phases = [];
for (const e of events) {
  if (!e || e.s !== 'PHASE') continue;
  const cum = Number(e.v?.ms ?? 0);
  const prev = phases.length ? phases[phases.length - 1].cum : 0;
  phases.push({ name: String(e.v?.n ?? '?'), cum, dur: Math.max(0, cum - prev) });
}
if (!phases.length) die('日志里一条 PHASE 都没有 —— 阶段耗时没有来源');

/* ── 2c. 网络名（从真实 netlist 汇总去重） ── */

const netSet = new Set();
const netlist = pick('netlist') ?? pick('netSummary') ?? [];
if (!Array.isArray(netlist)) die('netlist 条目的形状不是数组');
for (const c of netlist) {
  for (const v of Object.values(c?.pins || {})) if (v) netSet.add(v);
}
const nets = [...netSet].sort();
if (!nets.length) die('netlist 里一个网络名都没有 —— 视频会显示「0 网络」而没人知道是抽空了');

/* ── 2d. 质量指标 ── */

const schDrc = pick('schDrc') || {};
const drc = {
  // 唯一权威是 fabcheck 的退出码；这里只是「流水线自己跑完了没有」+ DRC 计数，别当成可下单。
  passed: gates.drcPassed === true,
  // 叶子层违规组数。`gates.drcTotalCount` 是类别层计数之和（本次 66），
  // 只看叶子数会被类别树骗过去，所以两个都记进 _provenance。
  violations: typeof gates.drcLeafCount === 'number' ? gates.drcLeafCount : null,
  schErrors: typeof gates.schDrcErrors === 'number' ? gates.schDrcErrors : schDrc.errors ?? null,
  schWarns: typeof schDrc.warns === 'number' ? schDrc.warns : null,
  mismatches: typeof gates.mismatches === 'number' ? gates.mismatches : null,
};

const snappedLines = numberField('snappedLines', 'snapped');
const copperPours = numberField('copperPours', 'count');
const clearanceFixes = numberField('clearanceFixes', 'count');

const route = pick('route');
const routed =
  route && typeof route.state === 'string'
    ? { state: route.state, ms: typeof route.ms === 'number' ? route.ms : null }
    : null;

/* ── 2e. 产物字节数（真读磁盘）+ Gerber.zip 内文件数（真读中央目录） ── */

const artifactSpec = [
  { file: 'Gerber.zip', label: 'Gerber 制造文件', note: '钻孔 / 丝印 / 钢网' },
  // 页码由 PDF 自己决定，不写进 note —— 写死一个数字就是下一个烂引用。
  { file: 'Board.pdf', label: 'PCB 版图 PDF', note: '装配与布线图' },
  { file: 'BOM.xlsx', label: '物料清单', note: 'LCSC 编号 / 数量' },
  { file: 'PnP.csv', label: '贴片坐标', note: 'UTF-16LE / TAB' },
  { file: 'Netlist.json', label: '网表', note: '连通性快照' },
  // 流水线早期导出 TestPoints.csv，后来导出 TestPoints.xlsx（fabcheck.js 两种都收）。
  { file: ['TestPoints.csv', 'TestPoints.xlsx'], label: '测试点', note: '飞针测试' },
];

function humanSize(b) {
  if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024).toFixed(1) + ' KB';
}

const artifacts = [];
const missingArtifacts = [];
for (const a of artifactSpec) {
  const names = Array.isArray(a.file) ? a.file : [a.file];
  const found = names.find((n) => fs.existsSync(path.join(outDir, n)));
  if (!found) {
    missingArtifacts.push(names.join(' 或 '));
    continue;
  }
  const bytes = fs.statSync(path.join(outDir, found)).size;
  // file 记真实文件名（.csv / .xlsx 哪个在就记哪个），不记我们「希望」它叫什么。
  artifacts.push({ file: found, label: a.label, note: a.note, bytes, human: humanSize(bytes) });
}
if (missingArtifacts.length) {
  die(`out/${outName} 缺 ${missingArtifacts.length} 个产物：${missingArtifacts.join('、')}`, [
    '这几次运行可能没跑到 export 阶段，或者产物被清理了一部分。',
    '换一个产物齐全的 run：VIDEO_RUN=<名字> node scripts/collect-data.mjs',
  ]);
}

/**
 * 真实解压条目数：走 ZIP 的 End-of-Central-Directory + 中央目录记录。
 *
 * 不要用「数 `PK\x01\x02` 签名」那种写法：签名也可能出现在压缩数据里，
 * 于是这个数字会**静默**多出来几条 —— 一个只在坏样本上错的量具等于没有量具。
 * 返回 null 表示中央目录不可用（调用方必须退 2，不能当成 0 条）。
 */
function zipEntryNames(buf) {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const total = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < total; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) return null;
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    names.push(buf.toString('utf8', off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

const gerberNames = zipEntryNames(fs.readFileSync(path.join(outDir, 'Gerber.zip')));
if (!gerberNames) {
  die('Gerber.zip 的中央目录读不出来（不是有效 zip）', [
    '「Gerber 内 N 个文件」这个数字没有来源，不能猜一个。',
    '换一个产物完整的 run。',
  ]);
}

/* ─────────────────────── 3. 组装 data.json ─────────────────────── */

const elapsedMs = Number(run.elapsedMs);
if (!Number.isFinite(elapsedMs)) die('_run.json 里没有可用的 elapsedMs');

// 字段 → 出处（写进 _provenance 和 PROVENANCE.md 的同一张表）。
const fieldSources = {
  generatedAt: '本脚本运行时 `new Date().toISOString()`（生成时刻，不是流水线测量值）',
  outName: '`out/` 下的目录名',
  outDirRel: '`out/<outName>`',
  designId: '`designs/` 下设计文件名（去 `.json`）',
  designName: '`_run.json#designName`（= 设计快照 `#name`）',
  designFriendly: '设计快照 `#friendly`',
  idea: '设计快照 `#_idea`（= `_run.json#idea`）',
  'components[]': '设计快照 `#components[].{des,lcsc,value}`',
  componentCount: '设计快照 `#components.length`',
  connectionCount: '设计快照 `#connections.length`',
  'nets[]': '`_log.json#entries[s=netlist].v[].pins` 去重去空后排序',
  netCount: '`nets.length`',
  'board.widthMil': '`_run.json#boardWidthMil`（本次实际生效的板框）',
  'board.heightMil': '`_run.json#boardHeightMil`',
  'board.name': '`_log.json#entries[s=board].v.name`',
  'board.sch': '`_log.json#entries[s=board].v.schName`',
  'drc.passed': '`_run.json#gates.drcPassed`',
  'drc.violations': '`_run.json#gates.drcLeafCount`（叶子层违规组数）',
  'drc.schErrors': '`_run.json#gates.schDrcErrors`',
  'drc.schWarns': '`_log.json#entries[s=schDrc].v.warns`',
  'drc.mismatches': '`_run.json#gates.mismatches`',
  elapsedMs: '`_run.json#elapsedMs`',
  elapsedSec: '`elapsedMs / 1000` 保留 1 位小数',
  'phases[]': '`_log.json#entries[s=PHASE].v` 的 `{n, ms}`；`ms` 是**累计**毫秒，`dur` 为相邻差分',
  phaseCount: '`phases.length`',
  copperPours: '`_log.json#entries[s=copperPours].v.count`',
  snappedLines: '`_log.json#entries[s=snappedLines].v.snapped`',
  clearanceFixes: '`_log.json#entries[s=clearanceFixes].v`（数字）',
  routed: '`_log.json#entries[s=route].v` 的 `{state, ms}`',
  gerberEntries: '`Gerber.zip` 中央目录记录数（真实解压条目）',
  'artifacts[].bytes': '`out/<run>/<file>` 的 `statSync().size`（不信 log 里的 size）',
  'artifacts[].human': '`bytes / 1024` 保留 1 位 + 单位',
  exportsOk: '`_run.json#gates.exportsOk`',
  exportsTotal: '`_run.json#gates.exportsTotal`',
  _source: '同名字段，冗余记录来源目录与设计路径',
  _provenance: '本表 + 三个输入文件的 mtime / sha256（机器可读副本）',
};

const data = {
  generatedAt: new Date().toISOString(),
  outName,
  outDirRel,
  designId: designFile ? designFile.id : null,
  designName: design.name,
  designFriendly: design.friendly ?? null,
  idea: design._idea ?? null,
  // 注意：这里**不**再塞 designRaw（设计全文）。没有任何组件读它，
  // 而一份 13KB 的副本会让「设计改了两处」这种漂移无声无息。
  components,
  componentCount: components.length,
  connectionCount: design.connections.length,
  nets,
  netCount: nets.length,
  board: {
    widthMil: typeof run.boardWidthMil === 'number' ? run.boardWidthMil : null,
    heightMil: typeof run.boardHeightMil === 'number' ? run.boardHeightMil : null,
    name: pick('board')?.name ?? run?.gates?.boardName ?? null,
    sch: pick('board')?.schName ?? null,
  },
  drc,
  elapsedMs,
  elapsedSec: +(elapsedMs / 1000).toFixed(1),
  phases,
  phaseCount: phases.length,
  copperPours,
  snappedLines,
  clearanceFixes,
  routed,
  gerberEntries: gerberNames.length,
  artifacts,
  exportsOk: typeof gates.exportsOk === 'number' ? gates.exportsOk : null,
  exportsTotal: typeof gates.exportsTotal === 'number' ? gates.exportsTotal : null,
  _source: {
    runDir: outDirRel,
    designPath: designFile ? designFile.rel : path.relative(ROOT, designPath).replace(/\\/g, '/'),
    designFile: designFile ? designFile.rel : null,
    runJson: `${outDirRel}/_run.json`,
    logJson: `${outDirRel}/_log.json`,
    designSnapshot: fs.existsSync(snapPath) ? `${outDirRel}/_design.snapshot.json` : null,
  },
  _provenance: {
    schema: 'video/src/data.json · v2（本脚本生成）',
    script: 'video/scripts/collect-data.mjs',
    run: {
      outName,
      runJsonMtime: iso(runPath),
      logJsonMtime: iso(logPath),
      designSnapshotMtime: fs.existsSync(snapPath) ? iso(snapPath) : null,
      designSnapshotSha256: fs.existsSync(snapPath) ? sha256(snapPath) : null,
      designFile: designFile ? designFile.rel : null,
      designFileSha256: designFile ? sha256(designFile.abs) : null,
      logSource,
      pinnedBy: hasEnv ? 'VIDEO_RUN' : 'PINNED_RUN',
      selection: hasEnv
        ? '环境变量显式指定'
        : 'out/ 下产物齐全（_run.json + _log.json + Gerber.zip）的 run 中 exportsOk 最高、再取最新',
    },
    fields: fieldSources,
  },
};

/* ────────────────── 4. 写 data.json + PROVENANCE.md ────────────────── */

fs.mkdirSync(path.dirname(DATA_DEST), { recursive: true });
fs.writeFileSync(DATA_DEST, JSON.stringify(data, null, 2) + '\n', 'utf8');

/** 本 run 里为 null 的字段 → 为什么缺、缺了画面会怎样（task 要求：不许编造）。 */
const nullNotes = {
  'copperPours': '日志里没有 copperPours 条目 —— 质量页「N 块铜皮灌注」会显示 null。',
  'snappedLines': '日志里没有 snappedLines 条目 —— 质量页「N 条走线端点吸附」会显示 null。',
  'clearanceFixes': '日志里没有 clearanceFixes 条目（该字段目前没有组件读取）。',
  'routed': '日志里没有 route 条目 —— 视频没有用到，不影响画面。',
  'designId': 'designs/ 下找不到同名设计 —— 原理图页的路径文字会缺文件名。',
  'designFriendly': '设计里没有 friendly 字段。',
  'idea': '设计里没有 _idea 字段 —— 开场「一句话」会是空的。',
  'drc.violations': '_run.json#gates.drcLeafCount 缺失 —— 质量页违规数会显示 null。',
  'drc.schWarns': '日志里没有 schDrc.warns —— 质量页原理图告警数会显示 null。',
  'board.widthMil': '_run.json#boardWidthMil 缺失。',
  'board.heightMil': '_run.json#boardHeightMil 缺失。',
  'board.name': '日志里没有 board 条目。',
  'board.sch': '日志里没有 board 条目。',
  'exportsOk': '_run.json#gates.exportsOk 缺失。',
  'exportsTotal': '_run.json#gates.exportsTotal 缺失。',
};

const getPath = (obj, dotted) =>
  dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
// 只对**标量**字段做「是否缺失」判定：`components[]` / `artifacts[].bytes`
// 这类路径没法用点号取到值，混进来只会给出一份假缺失清单。
const missingFields = Object.keys(fieldSources).filter((k) => {
  if (k.includes('[]')) return false;
  const v = getPath(data, k);
  return v === null || v === undefined;
});

const rows = Object.entries(fieldSources)
  .map(([k, v]) => `| \`${k}\` | ${v} |`)
  .join('\n');

const schemaRows = [
  ['generatedAt', 'string(ISO)', '生成 data.json 的时刻', '无', '不影响画面；判断数据新旧'],
  ['outName', 'string', 'run 目录名', 'scenes.jsx:624,872', '画面出现 `undefined`'],
  ['outDirRel', 'string', '`out/<outName>`', '无', '无'],
  ['designId', 'string', 'designs/ 下设计文件名（去 .json）', 'scenes.jsx:275', '原理图页路径缺文件名'],
  ['designName', 'string', '设计名', 'scenes.jsx:871', '收尾署名缺'],
  ['designFriendly', 'string', '中文友好名', '无', '无'],
  ['idea', 'string', '需求原文', 'scenes.jsx:215', '开场「一句话」空白'],
  ['components[]', '{des,lcsc,value}[]', '器件表（设计值，非实际来料值）', 'scenes.jsx:321', '器件页空'],
  ['componentCount', 'number', '器件数', 'scenes.jsx:172,312', '大数字缺'],
  ['connectionCount', 'number', '连接数（design.connections）', 'scenes.jsx:317', '文案缺'],
  ['nets[]', 'string[]', '网络名去重排序', 'scenes.jsx:377', '网络页空'],
  ['netCount', 'number', '网络数', 'scenes.jsx:173,372', '大数字缺'],
  ['board', '{widthMil,heightMil,name,sch}', '板框与板名', '无（仅存档）', '无'],
  ['drc', '{passed,violations,schErrors,schWarns,mismatches}', '质量指标', 'scenes.jsx:722-724,816,875', '质量页缺'],
  ['elapsedMs', 'number', '总耗时毫秒', '无', '无'],
  ['elapsedSec', 'number', '总耗时秒（1 位小数）', 'scenes.jsx:175,874', '大数字缺'],
  ['phases[]', '{name,cum,dur}[]', '阶段累计 / 单阶段耗时', 'scenes.jsx:408-485', '流水线页空'],
  ['phaseCount', 'number', '阶段数', 'scenes.jsx:174,461', '大数字缺'],
  ['copperPours', 'number\\|null', '铜皮块数', 'scenes.jsx:814', '显示 null'],
  ['snappedLines', 'number\\|null', '走线端点吸附条数', 'scenes.jsx:816', '显示 null'],
  ['clearanceFixes', 'number\\|null', '间距修复数', '无', '无'],
  ['routed', '{state,ms}\\|null', '布线状态 / 耗时', '无', '无'],
  ['gerberEntries', 'number', 'Gerber.zip 内文件数', 'scenes.jsx:710', '文案缺'],
  ['artifacts[]', '{file,label,note,bytes,human}[]', '6 个产物（字节数真读磁盘）', 'scenes.jsx:592-693', '产物页空'],
  ['exportsOk', 'number\\|null', '导出成功数', '无', '无'],
  ['exportsTotal', 'number\\|null', '导出总数', '无', '无'],
  ['_source', 'object', '来源目录（冗余）', '无', '无'],
  ['_provenance', 'object', '机器可读溯源（本文件的数据副本）', '无', '无'],
]
  .map(
    ([k, t, mean, reader, miss]) => `| \`${k}\` | ${t} | ${mean} | ${reader} | ${miss} |`,
  )
  .join('\n');

const prov = `# \`video/src/data.json\` 溯源

> 本文件由 \`video/scripts/collect-data.mjs\` 生成，**不要手改**。
> 要改视频里的数字 = 改生成脚本并重跑，不要直接编辑 JSON —— 手写的数据下次还会腐烂。

## 1. 数据来自哪一次运行

| 项 | 值 |
| --- | --- |
| 运行目录 | \`${outDirRel}\` |
| 设计快照 | \`${data._source.designSnapshot ?? '（缺失，回退到 designs/ 下同名设计）'}\` |
| 设计文件 | \`${data._source.designFile ?? 'designs/ 下按 name 未找到'}\` |
| \`_run.json\` mtime | \`${data._provenance.run.runJsonMtime}\` |
| \`_log.json\` mtime | \`${data._provenance.run.logJsonMtime}\` |
| 设计快照 mtime | \`${data._provenance.run.designSnapshotMtime ?? '—'}\` |
| 设计快照 sha256 | \`${data._provenance.run.designSnapshotSha256 ?? '—'}\` |
| 设计文件 sha256 | \`${data._provenance.run.designFileSha256 ?? '—'}\` |
| \`data.json\` 生成于 | \`${data.generatedAt}\` |
| 日志读自 | \`${logSource}\` |
| 钉住方式 | \`${data._provenance.run.pinnedBy}\` —— ${data._provenance.run.selection} |

**复算命令**（唯一让这些数字重新落地的方式）：

\`\`\`powershell
# 用 PATH 里的 node，不写死作者机器上的绝对路径 —— 这里原来写的是
# 一个写死的 node.exe 全路径，于是生成出来的溯源文档把开发者路径一起发布了，
# 而 test/dev-path-scan.mjs 和 test/smoke.mjs 都会因此判红。
# 复算要的是「跑哪条命令」，不是「在我这台机器上是哪个二进制」。
& node 'video\\scripts\\collect-data.mjs'
# 校验：
& node -e "const d=require('./video/src/data.json');console.log('keys=',Object.keys(d).join(','))"
\`\`\`

## 2. 每个数字的出处

同一张表也写在 \`data.json\` 的 \`_provenance.fields\` 里（机器可读）。

| 字段 | 出处 |
| --- | --- |
${rows}

## 3. \`data.json\` 的 schema（谁读它 / 缺了画面会怎样）

\`data.json\` 只被 \`video/src/scenes.jsx\` 读取（\`import data from './data.json'\`）。
下面是**全部**顶层键，行号指向 \`video/src/scenes.jsx\` 的真实使用点。

| 字段 | 类型 | 语义 | 读取方 | 缺失时 |
| --- | --- | --- | --- | --- |
${schemaRows}

## 4. 本次 run 的口径（为什么有些数字看着「不好」）

- \`_run.json#ok = ${run.ok === true}\`：跑的是「流水线自己跑完了没有」，**不是**「能不能下单」。
  可下单性的唯一权威是 \`fabcheck\` 的退出码（见 \`AGENTS.md\` 三条不许）。
- \`gates.drcPassed = ${gates.drcPassed}\`、\`gates.drcLeafCount = ${gates.drcLeafCount}\`、
  \`gates.drcTotalCount = ${gates.drcTotalCount}\`、\`gates.errors = ${gates.errors}\`。
  叶子层违规 ${gates.drcLeafCount} 组 / 类别层计数之和 ${gates.drcTotalCount}；
  门禁错误 ${gates.errors} 条：${JSON.stringify(gates.errorList ?? [])}。
- **画面文案与数据不一致（已知，未修）**：\`scenes.jsx\` 第 814 行的「DRC 全部通过」是
  **硬编码字符串**，不由 \`data.json\` 驱动，所以它不会跟着 \`drc.passed=${gates.drcPassed}\` 变。
  这一版数据下它是一句假话。要发布这一版视频，二选一：
  1. 把该行改成读 \`data.drc.passed\`（改 \`scenes.jsx\`，属于视频工程改动）；
  2. 换一条 DRC 全过的 run：\`VIDEO_RUN=${candidates.find((c) => c.ok && c.drcLeafCount === 0)?.name ?? '<你的 run>'}\`。
- 两个 \`drc\` 数字的口径不同：\`violations\` 是**叶子层**（${gates.drcLeafCount}），
  \`gates.drcTotalCount\`（${gates.drcTotalCount}）是类别层计数之和，**不能**互相替代。

## 5. 缺失字段（本 run 为 null 的项）

${missingFields.length ? missingFields.map((k) => `- \`${k}\`：${nullNotes[k] ?? '（见 _provenance）'}`).join('\n') : '无 —— 这次 run 里每个字段都有真实来源，没有一个是编的。'}

## 6. 不再写入的字段

- \`designRaw\`：旧版脚本把整份设计 JSON 塞进 \`data.json\`。没有任何组件读它，
  而一份 13KB 的副本会让「设计改了两处」这种漂移无声无息。设计请直接看 \`designs/\`。
`;

fs.writeFileSync(PROV_DEST, prov, 'utf8');

console.log('[collect-data] source :', outName);
console.log('[collect-data] design :', data._source.designFile, '(snapshot sha256 ' + String(data._provenance.run.designSnapshotSha256).slice(0, 12) + ')');
console.log('[collect-data] phases :', data.phases.length, ' total:', data.elapsedSec + 's');
console.log('[collect-data] drc    :', JSON.stringify(data.drc));
console.log('[collect-data] nets   :', data.netCount, nets.join(','));
console.log('[collect-data] gerber :', data.gerberEntries, 'entries; artifacts', data.artifacts.length, 'files');
console.log('[collect-data] wrote  :', path.relative(ROOT, DATA_DEST), '+', path.relative(ROOT, PROV_DEST));
