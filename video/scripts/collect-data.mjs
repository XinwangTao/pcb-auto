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

// 流水线在本机持续产出新 run，glob「最新」不稳定 → 显式钉住一个已核验的 run，
// 保证视频里的数字可复现。设 PINNED_RUN='' 则回退到「最新」。
const PINNED_RUN = 'SHT30_LDO_Module-20261125-010254';

function latest(dir, prefix) {
  const items = fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(prefix))
    .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!items.length) throw new Error(`no ${prefix}* under ${dir}`);
  return items[0].n;
}

const outName = PINNED_RUN && fs.existsSync(path.join(ROOT, 'out', PINNED_RUN))
  ? PINNED_RUN
  : latest(path.join(ROOT, 'out'), OUT_PREFIX);
const outDir = path.join(ROOT, 'out', outName);
const logPath = path.join(ROOT, 'logs', outName + '.json');
if (!fs.existsSync(logPath)) throw new Error('missing log ' + logPath);

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
  { file: 'TestPoints.csv', label: '测试点', note: '飞针测试' },
];
const artifacts = artifactSpec.map((a) => {
  const p = path.join(outDir, a.file);
  const bytes = fs.statSync(p).size;
  return { ...a, bytes, human: humanSize(bytes) };
});

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
