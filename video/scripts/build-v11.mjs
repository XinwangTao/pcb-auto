#!/usr/bin/env node
/**
 * build-v11.mjs · 把「最近一次真实录制」的帧挑成一条时间线，写 public/v11/manifest.json
 *
 * 和 build-v10.mjs 的差别只有一个，但很关键：
 *   v10 的段表**写死了批次号与帧文件名**（140310 / 175901 / 0002-layout-t6s …），
 *   换个批次就得改代码。v11 改成**按 tag 在当前批次里找帧** ——
 *   流水线的 shot() 只有 10 个 tag，每个调一次，名字前缀是拍摄序号（会变），
 *   后缀是 tag（稳定）。所以「按后缀找」才是可复用的那一种。
 *
 * 十段的顺序不是编的，就是 pipeline3.js 里 shot() 的调用顺序：
 *   sch-wired → pcb-imported → pcb-layout → pcb-pour → pcb-routed
 *   → pcb-bottom → pcb-stitched → pcb-clearance → pcb-patched → pcb-drc
 *
 * 三条硬断言（违反就退 1，不产出 manifest）：
 *   1) 每个选中的 PNG 头里宽高 > 0；
 *   2) **空画布**要能被挡住：实测空画布约 13 KB，真实画布 400–700 KB（差 45 倍）。
 *      这里不用绝对阈值（换分辨率就失效），而是比 **候选集中位数的 1/4** —— 相对判据。
 *   3) 同一段内 sha256 必须互不相同；跨段去重后把 distinct 数写进 manifest。
 *      按文件名挑「进度帧」会挑出多张一模一样的图，看着像卡住（v10 踩过）。
 *
 * 退出码：0 正常 / 2 缺输入（没有批次或没有帧）/ 1 断言失败
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIDEO_DIR = path.resolve(HERE, '..');
const REPO_DIR = path.resolve(VIDEO_DIR, '..');
const FRAMES_ROOT = path.join(REPO_DIR, 'out', 'frames');
const OUT_ROOT = path.join(REPO_DIR, 'out');
const PUBLIC_V11 = path.join(VIDEO_DIR, 'public', 'v11');
const IMG_DIR = path.join(PUBLIC_V11, 'img');
const MANIFEST = path.join(PUBLIC_V11, 'manifest.json');

const log = (...a) => console.log('[v11]', ...a);
const die = (msg, code) => { console.error(`[v11] 错误：${msg}`); process.exit(code); };

/* ---------------------------------------------------------------- 段表 */

// tag 的顺序 = pipeline3.js 里 shot() 的调用顺序，顺序错了时间线就倒流。
const BEATS = [
  {
    tag: 'sch-wired', title: '原理图连线完成',
    sub: (n) => `${n.components} 个器件 / ${n.connections} 根连接，全部按引脚号接出`,
    why: 'shot(sch-wired)：EDA 自己渲染的原理图画布',
  },
  {
    tag: 'pcb-imported', title: '导入 PCB',
    sub: () => '器件落进板框，蓝色飞线一条都还没走',
    why: 'shot(pcb-imported)',
  },
  {
    tag: 'pcb-layout', title: '按板形排开',
    sub: () => '功能带定位 + 最小位移分离，越界判据当场否决',
    why: 'shot(pcb-layout)',
  },
  {
    tag: 'pcb-pour', title: '两层铺铜',
    sub: () => 'GND 整片铺上，先把地给连通',
    why: 'shot(pcb-pour)',
  },
  {
    // 布线是唯一一段「画布真的在动」的画面：waitJob 轮询期间每 3.4 秒落一张
    // `route-t<N>s`，N 是进入布线后经过的秒数。按秒数排序后连播，观众能看到飞线被一条条吃掉。
    tagPrefix: /^route\d*-/, title: '布线器在走线',
    sub: (n, extra) => (extra && extra.span ? `同一次布线，${extra.span}` : '同一次布线，画面自己在变'),
    why: 'waitJob 轮询里的 pulse()：route-t<N>s 按秒数排序',
    multi: true,
  },
  {
    tag: 'pcb-routed', title: '布线器走完',
    sub: (n) => (n.routeState ? `routeState=${n.routeState}` : '布线阶段结束'),
    why: 'shot(pcb-routed)',
  },
  {
    tag: 'pcb-bottom', title: '翻到底层',
    sub: () => '换个层看，走线压在铜面之间',
    why: 'shot(pcb-bottom)',
  },
  {
    tag: 'pcb-stitched', title: '缝合补线',
    sub: () => '把断口逐段连上，连不上的撤掉而不是留着',
    why: 'shot(pcb-stitched)',
  },
  {
    tag: 'pcb-clearance', title: '间距修复',
    sub: () => '违规逐条认领：能推的推、能缩的缩，认不了的如实记账',
    why: 'shot(pcb-clearance)',
  },
  {
    tag: 'pcb-patched', title: '兜底补铜',
    sub: () => '前面没处理完的断连，这里最后过一遍',
    why: 'shot(pcb-patched)',
  },
  {
    tag: 'pcb-drc', title: 'DRC 零违规',
    sub: (n) => (n.drcLeaf == null ? 'DRC 结果见日志' : `DRC 叶子 ${n.drcLeaf} / 总数 ${n.drcTotal}，${Math.round((n.elapsedMs || 0) / 1000)} 秒跑完`),
    why: 'shot(pcb-drc)：最后一遍 DRC 之后的画布',
  },
];

/* ---------------------------------------------------------------- 工具 */

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** 读 PNG 头里的宽高。不是 PNG 或头坏了就返回 null —— 绝不返回 0 当"没问题"。 */
function pngSize(p) {
  const b = fs.readFileSync(p);
  if (b.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (b[i] !== sig[i]) return null;
  if (b.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length };
}

const argv = process.argv.slice(2);
const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const DRY = argv.includes('--dry');

/* ------------------------------------------------------- 选批次与尝试 */

let batches = [];
if (fs.existsSync(FRAMES_ROOT)) {
  batches = fs.readdirSync(FRAMES_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{6}$/.test(d.name))
    .map((d) => d.name)
    .sort();
}
if (!batches.length) die(`没有批次目录：${FRAMES_ROOT}`, 2);

const wantBatch = argOf('--batch');
const batch = wantBatch || batches[batches.length - 1];
if (!fs.existsSync(path.join(FRAMES_ROOT, batch))) die(`批次不存在：${batch}`, 2);
log(`批次 ${batch}（共 ${batches.length} 个：${batches.slice(-4).join(' → ')}）`);

const attemptDirs = fs.readdirSync(path.join(FRAMES_ROOT, batch), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
if (!attemptDirs.length) die(`批次 ${batch} 下没有尝试目录`, 2);

const wantAttempt = argOf('--attempt');
const attempt = wantAttempt || attemptDirs[attemptDirs.length - 1];
if (!attemptDirs.includes(attempt)) die(`批次 ${batch} 下没有尝试 ${attempt}（有：${attemptDirs.join(', ')}）`, 2);
log(`尝试 ${attempt}（共 ${attemptDirs.length} 个）`);

const dir = path.join(FRAMES_ROOT, batch, attempt);
const all = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png')).sort();
if (!all.length) die(`目录里没有 PNG：${dir}`, 2);
log(`原始帧 ${all.length} 张`);

/* ------------------------------------------------------ 按 tag 建索引 */

// 帧名形如 `0003-pcb-layout.png`：前缀是拍摄序号，后缀是 tag。
const byTag = new Map();
for (const f of all) {
  const m = f.match(/^(\d+)-(.+)\.png$/i);
  if (!m) continue;
  const tag = m[2];
  if (!byTag.has(tag)) byTag.set(tag, []);
  byTag.get(tag).push({ file: f, idx: Number(m[1]) });
}
log(`按 tag 分组：${[...byTag.keys()].sort().join(', ')}`);

const hitPrefix = (re) => [...byTag.keys()].some((k) => re.test(k));
const missing = BEATS.filter((b) => (b.tag && !byTag.has(b.tag))
  || (b.tagPrefix && !hitPrefix(b.tagPrefix))).map((b) => b.tag || String(b.tagPrefix));
if (missing.length) {
  // 缺 tag 不等于失败：录制可能只跑了一部分。但必须说出来，并且不足以成片时退 1。
  log(`注意：本批次缺这些 tag → ${missing.join(', ')}`);
}

/* --------------------------------------------------------- 候选与尺寸 */

const candidates = [];
for (const b of BEATS) {
  const items = b.tagPrefix
    ? [...byTag.entries()].filter(([k]) => b.tagPrefix.test(k))
        .flatMap(([, v]) => v)
        // route-t<N>s → N，按真实秒数排；不是这个形状就退回到拍摄序号
        .sort((x, y) => {
          const sx = (x.file.match(/t(\d+)s/) || [])[1], sy = (y.file.match(/t(\d+)s/) || [])[1];
          if (sx != null && sy != null) return Number(sx) - Number(sy);
          return x.idx - y.idx;
        })
    : (byTag.get(b.tag) || []);
  for (const it of items) {
    const p = path.join(dir, it.file);
    const sz = pngSize(p);
    if (!sz) { log(`跳过（PNG 头不可读）：${it.file}`); continue; }
    // tag 一定要是**字符串**。曾经写成 `c.beat.tag || c.beat.tagPrefix`，
    // 而 tagPrefix 是一个 RegExp ⇒ JSON.stringify 它就变成了 `{}`，
    // 组件又把 frame.tag 当子节点渲染 ⇒ React #31「object with keys {}」，
    // 而报错点是**第 201 帧**（第 3 段起点）—— 两件事霧在一起。
    const tagName = (it.file.match(/^\d+-(.+)\.png$/i) || [])[1] || String(b.tag || '');
    candidates.push({ beat: b, tagName, ...it, path: p, ...sz, sha: sha(p) });
  }
}
if (!candidates.length) die(`批次 ${batch}/${attempt} 里没有任何可用帧（10 个 tag 一个都没命中）`, 2);

const sizes = candidates.map((c) => c.bytes).sort((a, b) => a - b);
const median = sizes[Math.floor(sizes.length / 2)];
const floor = Math.floor(median / 4);
log(`候选 ${candidates.length} 张；字节 中位 ${median} / 最小 ${sizes[0]} / 空画布下限 ${floor}（中位数/4）`);

const problems = [];
const kept = [];
const seenShaInBeat = new Map();
let dedupedInBeat = 0;
for (const c of candidates) {
  if (c.bytes < floor) {
    // 相对判据：实测空画布 13KB vs 真实 400–700KB。绝对阈值换个分辨率就失效。
    problems.push(`${c.file} 只有 ${c.bytes} B < 空画布下限 ${floor}（中位 ${median}）—— 疑似空画布`);
    continue;
  }
  const bt = c.beat.tag || String(c.beat.tagPrefix);
  if (seenShaInBeat.get(bt) === c.sha) {
    // 段内重复 = 画布还没变就又落了一帧。这是**预期**，不是缺陷，
    // 所以计进 dedupedInBeat 而不是 problems；否则一个正常去重会把真问题淹没。
    dedupedInBeat++;
    continue;
  }
  seenShaInBeat.set(bt, c.sha);
  kept.push(c);
}

/* ------------------------------------------------------------- 跑数 */

// 板子/DRC/耗时这些数字**不手写**，从被录制那一轮的 _run-<attempt>.json 现读。
function findRunJson() {
  const hits = [];
  for (const d of fs.readdirSync(OUT_ROOT, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const f = path.join(OUT_ROOT, d.name, `_run-${attempt}.json`);
    if (fs.existsSync(f)) hits.push({ f, m: fs.statSync(f).mtimeMs });
  }
  if (!hits.length) return null;
  // 㼀实测踩过：不加窗口时会匹配到别的设计（批次 221908 匹上了 02:49 的锂电池板）。
  // 20 分钟窗口：一轮建筑实测 450–790 秒，超过这个就不是同一轮，宁可不拿也不猜。
  const anchor = fs.statSync(dir).mtimeMs;
  const WINDOW = 20 * 60 * 1000;
  const near = hits.filter((h) => Math.abs(h.m - anchor) <= WINDOW);
  if (!near.length) return null;
  near.sort((a, b) => Math.abs(a.m - anchor) - Math.abs(b.m - anchor));
  log(`跑数时间差 ${Math.round(Math.abs(near[0].m - anchor) / 1000)}s（窗口 ${WINDOW / 1000}s）`);
  return near[0].f;
}
const runFile = findRunJson();
let run = {};
if (runFile) {
  try { run = JSON.parse(fs.readFileSync(runFile, 'utf8')); } catch (e) { run = {}; }
  log(`跑数来源：${path.relative(REPO_DIR, runFile)}`);
} else {
  log('注意：找不到匹配的 _run-<attempt>.json —— 数字字段将留空，不编造');
}
const g = run.gates || {};
const numbers = {
  components: run.components ?? null,
  connections: run.connections ?? null,
  // 【读错地方就是读不到】实测：_run.json 顶层**没有** drcLeafCount，
  // 它在 gates 里（gates.drcLeafCount / drcTotalCount / drcPassed）。读错位置的后果
  // 不是报错，是成片里打出一行「DRC 未过 null/null 组」—— 看起来像测量结果。
  drcLeaf: g.drcLeafCount ?? null,
  drcTotal: g.drcTotalCount ?? null,
  elapsedMs: run.elapsedMs ?? null,
  routeState: g.routeState ?? null,
};
// 【形状必须与 v10 一致】PcbRealV11.jsx 直接读 run.design / run.board / run.drcPassed /
// run.drcLeaf / run.drcTotal / run.errors 拼那一行「事实条」。v10 的 run 里有这些键，
// 我的少写几个 ⇒ 模板字符串拼出 "undefined"，而 React 一开始报的是第 201 帧
// （第 3 段起点）的 #31。两件事霧一起看不出因果，所以这里把键配齐。
const runFilled = {
  available: !!runFile,
  runFile: runFile ? path.relative(REPO_DIR, runFile).replace(/\\/g, '/') : null,
  design: run.designName ?? null,
  board: (run.boardWidthMil != null && run.boardHeightMil != null) ? `${run.boardWidthMil}×${run.boardHeightMil}` : null,
  drcPassed: g.drcPassed ?? null,
  mismatches: g.mismatches ?? null,
  exportsOk: g.exportsOk ?? null,
  exportsTotal: g.exportsTotal ?? null,
  drcLeaf: numbers.drcLeaf,
  drcTotal: numbers.drcTotal,
  errors: g.errors ?? null,
  routeState: numbers.routeState,
  elapsedMs: numbers.elapsedMs,
  // 组件的事实条末尾读的是 elapsedS（秒），不是 elapsedMs。
  // 少这一个字段不会报错，只会在成片里打出一个孤零零的 "undefineds"。
  elapsedS: numbers.elapsedMs != null ? Math.round(numbers.elapsedMs / 1000) : null,
  why: runFile ? null : '本轮没找到对应的 _run-<attempt>.json（时间窗 20 分钟内）',
};

/* ------------------------------------------------------------- 落地 */

const beatsOut = [];
let copied = 0;
if (!DRY) {
  fs.rmSync(IMG_DIR, { recursive: true, force: true });
  fs.mkdirSync(IMG_DIR, { recursive: true });
}
const distinctAll = new Set();
const dropped = [];
for (const b of BEATS) {
  const frames = kept.filter((c) => c.beat === b);
  if (!frames.length) continue;
  // 【跨段去重】不同 tag 可能拍到同一幅画面（画布没变就落帧）。
  // 两段一模一样的图在成片里看起来就是「卡住了」。已见过的就整段丢掉并记录。
  // 段内去重：实测 route2-t6s..t47s 六张字节完全相同（69009 B）——
  // 它们是“画布还没变就又落了一帧”，全放进去就是一张图停 6 倍时间。
  const seenInBeat = new Set();
  const deduped = frames.filter((c) => { if (seenInBeat.has(c.sha)) return false; seenInBeat.add(c.sha); return true; });
  // 只有整段都与**前面的**某一段重复时才丢掉这一段（不同 tag 拍到同一幅画面）。
  const fresh = deduped.filter((c) => !distinctAll.has(c.sha));
  if (!fresh.length) {
    dropped.push({ id: b.tag || String(b.tagPrefix), why: `全部 ${frames.length} 帧都与前面已用过的帧字节相同` });
    continue;
  }
  const beatId = b.tag || (b.tagPrefix ? 'route' : 'beat');
  const files = [];
  fresh.forEach((c, i) => {
    const name = `${beatId}-${String(i + 1).padStart(2, '0')}.png`;
    if (!DRY) fs.copyFileSync(c.path, path.join(IMG_DIR, name));
    copied++;
    distinctAll.add(c.sha);
    if (typeof c.tagName !== 'string' || !c.tagName) {
      die(`帧 ${c.file} 的 tag 不是字符串（${typeof c.tagName}）—— 它会被当成 React 子节点渲染`, 1);
    }
    files.push({
      file: `v11/img/${name}`,
      src: `${batch}/${attempt}/${c.file}`,
      tag: c.tagName,
      idx: c.idx,
      w: c.w, h: c.h, bytes: c.bytes,
    });
  });
  // route-* 那段把「开始到结束」的真实秒数写进副标题，而不是写一句没分母的「布线中」
  const secs = fresh.map((c) => (c.file.match(/t(\d+)s/) || [])[1]).filter((v) => v != null).map(Number);
  const extra = secs.length ? { span: `画布在 ${Math.min(...secs)}–${Math.max(...secs)} 秒之间变了 ${files.length} 次` } : {};
  const sub = typeof b.sub === 'function' ? b.sub(numbers, extra) : b.sub;
  beatsOut.push({
    id: beatId,
    batch, attempt,
    title: b.title,
    sub: sub || '',
    why: b.why,
    // 整帧不裁：Plate 用 contain 适配，宁可小一点也不把内容切掉。
    // v10 用过彩色像素 bbox 做裁剪，那需要 frames-stats.py 先量；本轮不做，别假装做了。
    crop: files.length ? { x: 0, y: 0, w: files[0].w, h: files[0].h } : null,
    srcW: files.length ? files[0].w : null,
    srcH: files.length ? files[0].h : null,
    pickNote: '',
    run: runFilled,
    frames: files,
  });
}

const manifest = {
  generatedAt: new Date().toISOString(),
  generator: 'video/scripts/build-v11.mjs',
  source: {
    framesRoot: 'out/frames',
    batch, attempt, attemptDirs,
    scannedPng: all.length,
    keptFrames: copied,
    distinctImages: distinctAll.size,
    medianBytes: median,
    blankFloorBytes: floor,
    missingTags: missing,
    droppedBeats: dropped,
    dedupedInBeat,
    problems,
  },
  beats: beatsOut,
};

log(`产出 ${beatsOut.length} 段 / ${copied} 张帧 / distinct ${distinctAll.size}`);
if (problems.length) log(`问题 ${problems.length} 条：\n  ` + problems.join('\n  '));

// 断言：段数与帧数必须撑得起一条片子，否则不要产出「看起来成功」的空 manifest。
const MIN_BEATS = 6;
if (beatsOut.length < MIN_BEATS) {
  die(`只有 ${beatsOut.length} 段可用（要求 ≥ ${MIN_BEATS}）；缺 tag：${missing.join(', ') || '无'}。`
    + '录制是否真的开了？（run-all 需要 -Record 或仓库根的 .record-on 哨兵文件）', 1);
}
if (copied < beatsOut.length) die('存在 0 帧的段 —— 时间线会空转', 1);

if (DRY) {
  log('（--dry，不写盘）');
} else {
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1), 'utf8');
  log(`已写 ${path.relative(REPO_DIR, MANIFEST)}`);
}
process.exit(0);
