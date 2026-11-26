#!/usr/bin/env node
/**
 * frames-to-v7.mjs · 真实录制帧目录 → PcbRealV7 素材 + manifest
 *
 * 一条命令（在 pcb-auto 根目录跑）：
 *   node video\scripts\frames-to-v7.mjs --frames out\frames\204140 --out video\public\v7\real [--limit 9]
 *
 * 素材来源：流水线在 9 个里程碑调 EDA 的 getCurrentRenderedAreaImage() 自己渲染画布，
 * 再用 saveFileToFileSystem() 落盘，文件名 `${4位序号}-${标签}.png`（如 0007-cam-pcb.png）。
 *
 * 本脚本做四件事：
 *   1. 扫 <frames> 顶层的 *.png（非 png、子目录一律忽略），按文件名里的序号 **数值** 升序
 *      （不是字典序：9999 在 10000 之前、0009 在 0010 之前）；
 *   2. 选一组「有叙事价值」的帧：
 *        先按标签分阶段（schematic / pcb(cam) / layout / pour / route / stitch /
 *        clearance / drc(patch) / final 九类），同一阶段只留序号最大的那张（最新状态），
 *        一类一张，按阶段顺序推进；类数不够 limit 时用等间隔抽样从剩下的帧补足；
 *   3. **复制**（不移动）成 <out>\v7r-01.png … v7r-NN.png，先清掉 <out> 里上一轮的 v7r-*.png；
 *   4. 写 video\public\v7\manifest.json —— **裸数组**（PcbRealV7.jsx 直接 .map 它，
 *      数组长度就是段数）。元素形如
 *        {"file":"v7/real/v7r-01.png","tag":"cam-pcb","src":"0007-cam-pcb.png", …}
 *      file 是相对 video\public\ 的路径，可直接喂 staticFile()。
 *      数组本身装不下「说明字段」，所以说明另存 video\public\v7\manifest.meta.json，
 *      保证 manifest.json 的数组形状不被破坏。
 *
 * 退出码：0 = 正常；2 = 帧目录不存在 / 目录里没有 png / 参数不合法；1 = 其他失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // …\video\scripts
const VIDEO_DIR = path.resolve(HERE, '..'); // …\video
const REPO_DIR = path.resolve(VIDEO_DIR, '..'); // …\pcb-auto
const PUBLIC_DIR = path.join(VIDEO_DIR, 'public');
const V7_DIR = path.join(PUBLIC_DIR, 'v7');
const MANIFEST_FILE = path.join(V7_DIR, 'manifest.json');
const META_FILE = path.join(V7_DIR, 'manifest.meta.json');
const DEFAULT_OUT_DIR = path.join(V7_DIR, 'real');
const DEFAULT_LIMIT = 9; // 与 PcbRealV7 的九段一致

/**
 * 叙事阶段表（顺序 = 成片顺序）。标签命中 words 里任一词即归入该类；
 * 多个词都命中时取**最长的那个**，同长取**靠后的阶段**——
 * 这样 `pcb-layout`/`pcb-drc`/`pcb-clearance` 这种复合标签会落到更具体的阶段，
 * 而不是被笼统的 `pcb` 吃掉。
 * 中文 label/sub 与 v7/prepare.mjs 的 STAGES 保持一致，让真实帧也有可读标题。
 */
const STAGES = [
  { key: 'sch-wired', label: '原理图连线', sub: '器件逐个落位，引脚逐根接出', words: ['schematic', 'sch', '原理', 'sheet'] },
  { key: 'pcb-imported', label: '导入 PCB', sub: '网表进 PCB，器件自动落板框', words: ['pcb', 'cam', 'import', 'netlist', 'board'] },
  { key: 'pcb-layout', label: '自动布局', sub: '按网络关系排布，缩短走线距离', words: ['layout', 'place', 'floorplan', '布局'] },
  { key: 'pcb-pour', label: '覆铜', sub: '双面覆铜，GND 铺满整板', words: ['pour', 'copper', 'fill', '覆铜'] },
  { key: 'pcb-routed', label: '自动布线', sub: '布线器逐条走线，过孔自动生成', words: ['rout', '布线'] },
  { key: 'pcb-stitched', label: '孤岛补线', sub: '孤立铜皮补过孔，GND 接回去', words: ['stitch', 'island', '补线'] },
  { key: 'pcb-clearance', label: '间距修复', sub: '间距不足就退回重走', words: ['clearance', 'clear', 'spacing', '间距'] },
  { key: 'pcb-drc', label: 'DRC 通过', sub: '零违规通过，制造文件一次导出', words: ['drc', 'patch', 'check', '检查'] },
  { key: 'pcb-final', label: '导出成品', sub: 'Gerber 一次导出，直接下单', words: ['final', 'export', 'gerber', 'done', 'share', '完成'] },
];

const log = (...a) => console.log('[frames-to-v7]', ...a);
const warn = (...a) => console.warn('[frames-to-v7] !', ...a);

const USAGE = `用法：node video\\scripts\\frames-to-v7.mjs --frames <out\\frames\\<HHmmss>> [--out video\\public\\v7\\real] [--limit 9]
  --frames  流水线录制的帧目录（必需，只扫顶层 png）
  --out     复制目标目录（默认 video\\public\\v7\\real）
  --limit   成片段数（默认 9，与 PcbRealV7 九段一致）`;

/** 参数/目录错误统一走这里：退出码 2 */
function die(msg) {
  console.error(`[frames-to-v7] 错误：${msg}`);
  console.error(USAGE);
  process.exit(2);
}

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** 从 PNG 头读宽高（IHDR 固定在 16..24 字节），不引入图片库；读不出返回 null */
function pngSize(file) {
  try {
    const buf = Buffer.alloc(24);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, 24, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
    if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- 参数解析 */

function parseArgv(argv) {
  const opts = { frames: null, out: DEFAULT_OUT_DIR, limit: DEFAULT_LIMIT, help: false };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    if (raw === '-h' || raw === '--help') {
      opts.help = true;
      continue;
    }
    let key = raw;
    let inline = null;
    const eq = raw.indexOf('=');
    if (raw.startsWith('--') && eq > 0) {
      key = raw.slice(0, eq);
      inline = raw.slice(eq + 1);
    }
    const value = () => {
      if (inline !== null) return inline;
      const v = args[++i];
      if (v === undefined) die(`参数 ${key} 缺少取值`);
      return v;
    };
    if (key === '--frames' || key === '-f') opts.frames = value();
    else if (key === '--out' || key === '-o') opts.out = value();
    else if (key === '--limit' || key === '-n') opts.limit = Number(value());
    else if (!raw.startsWith('-') && !opts.frames) opts.frames = raw; // 允许位置参数
    else die(`未知参数 ${raw}`);
  }
  return opts;
}

/** 相对路径先按 cwd 解析（文档命令就是这么跑的），再兜底按仓库根解析（在 video\ 里也能跑） */
function resolveInputDir(input) {
  const cands = path.isAbsolute(input)
    ? [path.normalize(input)]
    : [path.resolve(process.cwd(), input), path.resolve(REPO_DIR, input)];
  const uniq = [...new Set(cands)];
  for (const c of uniq) if (isDir(c)) return { dir: c, tried: uniq };
  return { dir: null, tried: uniq };
}

/* ---------------------------------------------------------------- 扫帧 / 排序 */

/** `${4位}-${tag}.png` → { idx, tag }；没有数字前缀的 idx 记为 +∞ 排最后并告警 */
function frameOf(name) {
  const base = name.replace(/\.png$/i, '');
  const m = base.match(/^(\d+)/);
  const idx = m ? Number(m[1]) : Number.POSITIVE_INFINITY;
  const tag = (m ? base.slice(m[1].length).replace(/^[\s._-]+/, '') : base).trim() || base;
  return { name, idx, tag, sortKey: Number.isFinite(idx) ? idx : Number.MAX_SAFE_INTEGER };
}

/** 数值升序（不是字典序），同序号再按名字；不依赖 localeCompare 的 numeric */
const bySeq = (a, b) => a.sortKey - b.sortKey || a.name.localeCompare(b.name, 'en');

function scanFrames(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const pngs = [];
  const ignored = [];
  for (const e of entries) {
    if (e.isFile() && /\.png$/i.test(e.name)) pngs.push(e.name);
    else ignored.push(e.name + (e.isDirectory() ? '\\' : ''));
  }
  return { frames: pngs.map(frameOf).sort(bySeq), ignored };
}

/* ---------------------------------------------------------------- 挑帧策略 */

/** 标签 → 阶段：最长关键词胜出，同长取靠后阶段（具体 > 笼统） */
function classify(tag) {
  const t = String(tag).toLowerCase();
  let best = null;
  STAGES.forEach((stage, order) => {
    for (const w of stage.words) {
      if (!t.includes(w)) continue;
      if (!best || w.length > best.len || (w.length === best.len && order > best.order)) {
        best = { stage, len: w.length, order };
      }
    }
  });
  return best ? best.stage : null;
}

/** 等间隔下采样（保留首尾），列表本身有序，用于「阶段比段数多」时 */
function downsample(list, n) {
  if (list.length <= n) return list.slice();
  if (n === 1) return [list[0]];
  const out = [];
  for (let k = 0; k < n; k++) {
    const item = list[Math.round((k * (list.length - 1)) / (n - 1))];
    if (!out.includes(item)) out.push(item);
  }
  for (const item of list) {
    if (out.length >= n) break;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

/** 从剩余帧里等间隔抽样 need 张（按池子的位置均匀取，不重复） */
function pickEvenly(pool, need, taken) {
  const remain = pool.filter((f) => !taken.has(f.name));
  if (need <= 0 || remain.length === 0) return [];
  if (remain.length <= need) {
    return remain.map((f, k) => ({ frame: f, note: `等间隔抽样（剩余池仅 ${remain.length} 张，全取 ${k + 1}/${remain.length}）` }));
  }
  if (need === 1) {
    const f = remain[Math.floor((remain.length - 1) / 2)];
    return [{ frame: f, note: `等间隔抽样（剩余池 ${remain.length} 张取正中）` }];
  }
  const out = [];
  const seen = new Set();
  for (let k = 0; k < need; k++) {
    const f = remain[Math.round((k * (remain.length - 1)) / (need - 1))];
    if (!f || seen.has(f.name)) continue;
    seen.add(f.name);
    out.push({ frame: f, note: `等间隔抽样（剩余池 ${remain.length} 张的第 ${k + 1}/${need} 点）` });
  }
  for (const f of remain) {
    if (out.length >= need) break;
    if (seen.has(f.name)) continue;
    seen.add(f.name);
    out.push({ frame: f, note: `等间隔抽样（取整撞点后补位）` });
  }
  return out.slice(0, need);
}

/**
 * 选帧主流程：
 *   A. 按阶段归类，每类取序号最大的（frames 已升序，最后一次覆盖即最新）；
 *   B. 阶段数 > limit → 按阶段顺序等间隔保留（首尾必留，保住"开头/收尾"）；
 *   C. 不足 limit → 从剩下的帧等间隔抽样补足；
 *   D. 最终按序号升序输出，保证画面按录制时间推进。
 */
function chooseFrames(frames, limit) {
  const byStage = new Map(); // stage.key → frame（升序遍历，最后写入即序号最大）
  for (const f of frames) {
    const stage = classify(f.tag);
    if (stage) byStage.set(stage.key, { frame: f, stage });
  }
  let stagePicks = STAGES.filter((s) => byStage.has(s.key)).map((s) => byStage.get(s.key));
  let stageNote = '';
  if (stagePicks.length > limit) {
    stagePicks = downsample(stagePicks, limit);
    stageNote = `（阶段 ${byStage.size} 类多于 ${limit} 段，按阶段顺序等间隔保留）`;
  }

  const picked = stagePicks.map((p) => ({
    frame: p.frame,
    why: 'tag',
    stage: p.stage,
    note: `标签阶段「${p.stage.label}」取该类序号最大的一张${stageNote}`,
  }));

  const taken = new Set(picked.map((p) => p.frame.name));
  const sampled = pickEvenly(frames, limit - picked.length, taken).map((s) => ({
    frame: s.frame,
    why: 'sample',
    stage: classify(s.frame.tag),
    note: s.note,
  }));

  const all = picked.concat(sampled);
  all.sort((a, b) => bySeq(a.frame, b.frame));
  return all;
}

/* ---------------------------------------------------------------- 落盘 */

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function main() {
  const opts = parseArgv(process.argv);
  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!opts.frames) die('缺少 --frames <帧目录>');
  if (!Number.isInteger(opts.limit) || opts.limit < 1) die(`--limit 必须是正整数，收到 ${opts.limit}`);

  const { dir, tried } = resolveInputDir(opts.frames);
  if (!dir) die(`帧目录不存在：${tried.join('  |  ')}`);

  const { frames, ignored } = scanFrames(dir);
  if (frames.length === 0) {
    die(`帧目录里没有 .png：${dir}（忽略的条目 ${ignored.length} 个${ignored.length ? `：${ignored.slice(0, 8).join(', ')}` : ''}）`);
  }

  const outDir = path.resolve(opts.out);
  const manifestRel = path.relative(PUBLIC_DIR, outDir).split(path.sep).join('/');
  if (!manifestRel || manifestRel.startsWith('..')) {
    warn(`--out 不在 video\\public\\ 下（${outDir}），staticFile() 取不到这些图；仅 manifest 仍会写。`);
  }

  log(`帧目录  : ${dir}`);
  log(`输出目录: ${outDir}`);
  log(`目标段数: ${opts.limit}（--limit）`);
  if (ignored.length) {
    const shown = ignored.slice(0, 12).join(', ');
    log(`忽略 ${ignored.length} 个非 png / 子目录：${shown}${ignored.length > 12 ? ` … 共 ${ignored.length} 个` : ''}`);
  }

  // 排序证据：直接把扫到的顺序打出来
  const head = frames.length <= 40 ? frames : frames.slice(0, 20);
  log(`扫描到 ${frames.length} 个 png，按序号数值升序：`);
  for (const f of head) {
    log(`   ${f.name.padEnd(28)} idx=${Number.isFinite(f.idx) ? String(f.idx).padStart(5, '0') : '  ★  '}  tag=${f.tag}`);
  }
  if (frames.length > head.length) {
    log(`   … 省略 ${frames.length - head.length} 个`);
  }
  const noIdx = frames.filter((f) => !Number.isFinite(f.idx));
  if (noIdx.length) warn(`有 ${noIdx.length} 个 png 没有数字序号，已排到最后：${noIdx.map((f) => f.name).join(', ')}`);

  // 挑帧
  const chosen = chooseFrames(frames, opts.limit);
  if (chosen.length < opts.limit) {
    warn(`可用帧只有 ${chosen.length} 张，不足 --limit ${opts.limit}，本次就出 ${chosen.length} 段。`);
  }

  // 清掉上一轮产物，避免旧 v7r-*.png 残留
  if (isDir(outDir)) {
    let removed = 0;
    for (const n of fs.readdirSync(outDir)) {
      if (/^v7r-\d+\.png$/i.test(n)) {
        try {
          fs.rmSync(path.join(outDir, n), { force: true });
          removed++;
        } catch {
          /* ignore */
        }
      }
    }
    if (removed) log(`清掉上一轮产物 ${removed} 个 v7r-*.png`);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const items = [];
  const picked = [];
  chosen.forEach((pick, i) => {
    const dstName = `v7r-${String(i + 1).padStart(2, '0')}.png`;
    const srcPath = path.join(dir, pick.frame.name);
    const dstPath = path.join(outDir, dstName);
    if (path.resolve(srcPath) !== path.resolve(dstPath)) fs.copyFileSync(srcPath, dstPath); // 复制，不移动
    const size = pngSize(dstPath) || { w: 0, h: 0 };
    const stage = pick.stage || classify(pick.frame.tag);
    const file = path.relative(PUBLIC_DIR, dstPath).split(path.sep).join('/');
    items.push({
      file,
      tag: pick.frame.tag,
      src: pick.frame.name,
      idx: Number.isFinite(pick.frame.idx) ? pick.frame.idx : null,
      stage: stage ? stage.key : 'other',
      label: stage ? stage.label : pick.frame.tag || '画布状态',
      sub: stage ? stage.sub : '真实画布渲染帧',
      w: size.w,
      h: size.h,
      crop: null,
      placeholder: false,
      why: pick.why,
    });
    picked.push({ ...pick, dstName, file });
  });

  // manifest：裸数组，PcbRealV7.jsx 直接 .map
  writeJson(MANIFEST_FILE, items);

  // 说明字段放到 sidecar，数组形状不受影响
  writeJson(META_FILE, {
    generatedAt: new Date().toISOString(),
    generator: 'video/scripts/frames-to-v7.mjs',
    framesDir: dir,
    outDir,
    limit: opts.limit,
    count: items.length,
    scanned: frames.length,
    ignored,
    stages: items.map((it) => it.stage).filter((v, i, a) => a.indexOf(v) === i),
    selection: picked.map((p) => ({ file: p.file, src: p.frame.name, tag: p.frame.tag, why: p.why, note: p.note })),
    note: 'manifest.json 是裸数组（PcbRealV7.jsx 直接 .map）；说明字段只能放在本文件，避免破坏数组形状。',
  });

  // 打印选帧结果
  log(`选中 ${items.length} 张（标签 ${chosen.filter((c) => c.why === 'tag').length} + 抽样 ${chosen.filter((c) => c.why === 'sample').length}）：`);
  picked.forEach((p, i) => {
    log(`   ${String(i + 1).padStart(2, '0')}  ${p.file.padEnd(22)} ← ${String(p.frame.name).padEnd(24)} [${p.why}] ${p.note}`);
  });

  log(`manifest: ${MANIFEST_FILE}`);
  log(`说明    : ${META_FILE}`);

  // 自校验：数组 + file 在 public 下真实存在
  const parsed = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('manifest 不是数组');
  const missing = parsed.filter((it) => !fs.existsSync(path.join(PUBLIC_DIR, it.file)));
  if (missing.length) throw new Error(`manifest 里有 ${missing.length} 个 file 在 public 下找不到：${missing.map((m) => m.file).join(', ')}`);
  log(`校验通过：manifest 是数组，${parsed.length} 项；file 全部可 staticFile() 取到。`);
}

try {
  main();
} catch (err) {
  console.error('[frames-to-v7] 失败：', err && err.stack ? err.stack : err);
  process.exit(1);
}
