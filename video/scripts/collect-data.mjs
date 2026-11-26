#!/usr/bin/env node
/**
 * collect-data.mjs — 从 pcb-auto 真实产物里抽取视频要用的全部数字。
 * 只读 pcb-auto/out、pcb-auto/logs、pcb-auto/designs，绝不写。
 * 产物：video/src/data.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIDEO = path.resolve(__dirname, '..');
const ROOT = path.resolve(VIDEO, '..');
const require = createRequire(import.meta.url);

const DESIGN_ID = 'd3-sht30-ldo';
const OUT_PREFIX = 'SHT30_LDO_Module-';

// 流水线在本机持续产出新 run，glob「最新」不稳定 → 显式钉住一次 run，
// 保证视频里的数字可复现。
//
// 想换 run 不必改代码，用环境变量：
//   VIDEO_RUN=SHT30_LDO_Module-20261126-061250 node scripts/collect-data.mjs
// 只有显式设成空（VIDEO_RUN= ）才回退到「最新」。
//
// 为什么这里要「停下来」而不是「顺手换成最新」：out/ 会被 cleanup.ps1 自动清理
// （保留最新 40 个 + 每个设计名最新 1 个），钉住的那次 run 早晚会消失。
// 一旦静默换 run，视频里每一个数字都不再是注释里说的那一次，而输出看起来完全正常。
// 这是本仓库反复踩的同一类错：**量具读不到输入时不许沉默**。
const PINNED_RUN = 'SHT30_LDO_Module-20261125-010254';
const RUN_FROM_ENV = Object.prototype.hasOwnProperty.call(process.env, 'VIDEO_RUN');
const REQUESTED_RUN = RUN_FROM_ENV ? process.env.VIDEO_RUN.trim() : PINNED_RUN;

// 同步写 stderr：process.exit() 之前用 console.error 在管道上可能丢字。
function die(msg, hints = []) {
  fs.writeSync(2, '[collect-data] 没能开始：' + msg + '\n');
  for (const h of hints) fs.writeSync(2, '               ' + h + '\n');
  process.exit(2); // 2 = 输入/环境不对，没能测量（不是「判据为否」）
}

function latest(dir, prefix) {
  const items = fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(prefix))
    .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!items.length) {
    die(`out/ 下一个 ${prefix}* 都没有`, [
      '先跑一次流水线产出产物，或者用 VIDEO_RUN=<名字> 指定。',
    ]);
  }
  return items[0].n;
}

const outRoot = path.join(ROOT, 'out');
let outName;
if (REQUESTED_RUN) {
  if (!fs.existsSync(path.join(outRoot, REQUESTED_RUN))) {
    const avail = fs.existsSync(outRoot)
      ? fs.readdirSync(outRoot).filter((n) => n.startsWith(OUT_PREFIX)).sort().slice(-5)
      : [];
    die(`指定的 run 不存在：out/${REQUESTED_RUN}`, [
      'out/ 会被 cleanup.ps1 自动清理（保留最新 40 个 + 每个设计名最新 1 个），',
      '所以曾经钉住的那次 run 消失是正常的，不是仓库坏了。',
      '',
      '换一个现存的：VIDEO_RUN=<名字> node scripts/collect-data.mjs',
      '或者用最新的：VIDEO_RUN= node scripts/collect-data.mjs',
      '',
      avail.length ? `现存 ${OUT_PREFIX}* 最新的 ${avail.length} 个：` : `现存 ${OUT_PREFIX}*：一个都没有`,
      ...avail.map((n) => '  ' + n),
      '',
      '注意：换 run 之后，视频里每个数字都来自这一次，不再等于 PINNED_RUN 注释里的那一次。',
    ]);
  }
  outName = REQUESTED_RUN;
} else {
  outName = latest(outRoot, OUT_PREFIX);
}

const outDir = path.join(outRoot, outName);
const logPath = path.join(ROOT, 'logs', outName + '.json');
if (!fs.existsSync(logPath)) {
  die(`找到了 out/${outName}，但缺它的日志 logs/${outName}.json`, [
    '没有日志就没有阶段耗时 / DRC / 网络名，视频里的数字会变成猜的。',
    '换一个产物和日志都在的 run：VIDEO_RUN=<名字> node scripts/collect-data.mjs',
  ]);
}

const log = JSON.parse(fs.readFileSync(logPath, 'utf8')).value;
const design = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'designs', DESIGN_ID + '.json'), 'utf8')
);

// ---------- 阶段耗时（PHASE 条目是累计时间戳，取差分得单阶段耗时） ----------
const phases = [];
for (const e of log.log) {
  if (e.s !== 'PHASE') continue;
  const at = e.v.n;
  const cum = e.v.ms;
  const prev = phases.length ? phases[phases.length - 1].cum : 0;
  phases.push({ name: at, cum, dur: Math.max(0, cum - prev) });
}

// ---------- 产物文件大小（真读磁盘，不信任 log 里的 size 字段） ----------
const artifactSpec = [
  { file: 'Gerber.zip', label: 'Gerber 制造文件', note: '钻孔 / 丝印 / 钢网' },
  { file: 'Board.pdf', label: 'PCB 版图 PDF', note: '6 页装配与布线图' },
  { file: 'BOM.xlsx', label: '物料清单', note: '7 行 / LCSC 编号' },
  { file: 'PnP.csv', label: '贴片坐标', note: 'UTF-16LE / TAB' },
  { file: 'Netlist.json', label: '网表', note: '连通性快照' },
  // 流水线早期导出 TestPoints.csv，后来导出 TestPoints.xlsx（fabcheck.js L336 同样两种都收）。
  // 实测 out\ 语料里 .xlsx 47 个、.csv 14 个 —— 写死 .csv 会让新 run 直接崩。
  { file: ['TestPoints.csv', 'TestPoints.xlsx'], label: '测试点', note: '飞针测试' },
];
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

function humanSize(b) {
  if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024).toFixed(1) + ' KB';
}

// ---------- Gerber.zip 内文件数（真实解压计数） ----------
let gerberEntries = 0;
try {
  const AdmZip = null; // 不引第三方；用 zip 中央目录粗略计数
  const buf = fs.readFileSync(path.join(outDir, 'Gerber.zip'));
  // 数 End-of-central-directory 前每个 "PK\x01\x02" 记录
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x01 && buf[i + 3] === 0x02) gerberEntries++;
  }
} catch {}

// ---------- 网络名（从真实 netlist 汇总去重） ----------
const netNames = new Set();
for (const c of log.netSummary || log.netlist || []) {
  for (const v of Object.values(c.pins || {})) if (v) netNames.add(v);
}
const nets = [...netNames].sort();

// ---------- 附加真实指标 ----------
const pick = (stage) => {
  const e = log.log.find((x) => x.s === stage);
  return e ? e.v : null;
};
const route = pick('route');
const copperPours = pick('copperPours');

const data = {
  generatedAt: new Date().toISOString(),
  outName,
  outDirRel: `out/${outName}`,
  designId: DESIGN_ID,
  designName: design.name,
  designFriendly: design.friendly,
  idea: design._idea,
  designRaw: fs.readFileSync(path.join(ROOT, 'designs', DESIGN_ID + '.json'), 'utf8'),
  board: {
    widthMil: design.boardWidthMil,
    heightMil: design.boardHeightMil,
    name: log.boardName,
    sch: log.schName,
  },
  components: (log.components || design.components).map((c) => ({
    des: c.des,
    lcsc: c.lcsc,
    value: c.value,
  })),
  componentCount: (log.components || design.components).length,
  connectionCount: design.connections.length,
  nets,
  netCount: nets.length,
  // 真实质量指标
  drc: {
    passed: log.drcPassed === true,
    violations: log.drcDetailCount ?? 0,
    schErrors: log.schDrcErrors ?? 0,
    schWarns: log.schDrcWarns ?? 0,
    mismatches: log.mismatchCount ?? 0,
  },
  // 真实流程指标
  elapsedMs: log.elapsedMs,
  elapsedSec: +(log.elapsedMs / 1000).toFixed(1),
  phases,
  phaseCount: phases.length,
  copperPours: copperPours ? copperPours.count : null,
  snappedLines: pick('snappedLines') ?? null,
  clearanceFixes: pick('clearanceFixes') ?? null,
  routed: route ? { state: route.state, ms: route.ms } : null,
  gerberEntries,
  artifacts,
  exportsOk: (log.exports || []).filter((e) => e.ok).length,
  exportsTotal: (log.exports || []).length,
};

const dest = path.join(VIDEO, 'src', 'data.json');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(data, null, 2), 'utf8');

console.log('[collect-data] source :', outName);
console.log('[collect-data] phases :', data.phases.length, ' total:', data.elapsedSec + 's');
console.log('[collect-data] drc    :', JSON.stringify(data.drc));
console.log('[collect-data] nets   :', data.netCount, nets.join(','));
console.log('[collect-data] wrote  :', path.relative(VIDEO, dest));
