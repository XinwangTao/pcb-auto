/**
 * PcbRealV7 · 素材发现 / 占位同步
 *
 * 目的：流水线把 EDA 自己渲染的画布 PNG 落到 out/frames/<HHmmss>/ 下（0000-<tag>.png …），
 * 但 Remotion 只能通过 staticFile() 访问 public/ 里的文件，而且 1080x1920 的
 * durationInFrames 必须在打包期就确定。所以这里在 **CLI 启动时（打包之前）**
 * 由 remotion.config.mjs 调用一次：
 *
 *   1. 找 out/frames/ 下最新的时间戳目录（按名字倒序，取第一个有 png 的）；
 *   2. 找不到就退回 out/stills/*.png（成片抽帧，仅作占位）；
 *   3. 把选中的 PNG 硬链接（失败则复制）到 public/v7/img/；
 *   4. 生成 public/v7/manifest.json，供 src/PcbRealV7.jsx 直接 import。
 *
 * 全程不抛异常：任何一步失败都退回"上一版 manifest 原样保留"，
 * 保证 PcbAuto / PcbReal / PcbRealV6 三个老合成绝不会因为这里挂掉。
 *
 * manifest 形状兼容（两版并存）：
 *   - 本文件写的是老形状 { items, source, count, … }；
 *   - scripts/frames-to-v7.mjs 写的是**裸数组**（人工/脚本挑好的真实录制帧清单，
 *     PcbRealV7.jsx 直接 .map 它）。数组形状一旦存在，本函数**原样保留不覆盖**——
 *     remotion.config.js 每次 CLI 启动都会起子进程跑这里，覆盖掉等于把选帧结果冲掉。
 *   读旧文件请用下面的 readManifest()，两种形状都能读。
 *
 * 单独调试：node v7/prepare.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIDEO_DIR = path.resolve(HERE, '..');
const OUT_DIR = path.join(VIDEO_DIR, 'out');
const FRAMES_ROOT = path.join(OUT_DIR, 'frames');
const STILLS_DIR = path.join(OUT_DIR, 'stills');
const PUBLIC_V7 = path.join(VIDEO_DIR, 'public', 'v7');
const IMG_DIR = path.join(PUBLIC_V7, 'img');
const MANIFEST = path.join(PUBLIC_V7, 'manifest.json');

/**
 * 读现有 manifest，两种形状都认：
 *   array            → frames-to-v7.mjs 产出的真实录制帧清单（裸数组）
 *   { items, source } → 本文件产出的老形状
 * 读不出来（没有文件 / 坏 JSON）返回 null，调用方按"没有旧 manifest"处理。
 */
export function readManifest() {
  try {
    const raw = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    if (Array.isArray(raw)) return { shape: 'array', source: 'real', items: raw };
    if (raw && Array.isArray(raw.items)) return { shape: 'object', source: raw.source, items: raw.items };
  } catch {
    /* 没有 / 坏 JSON：当作没有 */
  }
  return null;
}

/** 流水线 9 个里程碑：tag → 中文小标题 + 一句字幕
 *  字幕控制在 ≤16 个汉字（约 840px @52px），竖屏一行读完，不会被折行拆词 */
export const STAGES = {
  'sch-wired': { label: '原理图连线', sub: '器件逐个落位，引脚逐根接出' },
  'pcb-imported': { label: '导入 PCB', sub: '网表进 PCB，器件自动落板框' },
  'pcb-layout': { label: '自动布局', sub: '按网络关系排布，缩短走线距离' },
  'pcb-pour': { label: '覆铜', sub: '双面覆铜，GND 铺满整板' },
  'pcb-routed': { label: '自动布线', sub: '布线器逐条走线，过孔自动生成' },
  'pcb-stitched': { label: '孤岛补线', sub: '孤立铜皮补过孔，GND 接回去' },
  'pcb-clearance': { label: '间距修复', sub: '间距不足就退回重走' },
  'pcb-patched': { label: 'DRC 兜底', sub: 'DRC 前统一兜底修补' },
  'pcb-drc': { label: 'DRC 通过', sub: '零违规通过，制造文件一次导出' },
};

/** 流程顺序（占位素材按序号铺满全流程时用） */
export const STAGE_ORDER = [
  'sch-wired', 'pcb-imported', 'pcb-layout', 'pcb-pour', 'pcb-routed',
  'pcb-stitched', 'pcb-clearance', 'pcb-patched', 'pcb-drc',
];

/** tag 里出现这些词就认成对应里程碑（真实 tag 常带前后缀，如 job-layout / drc-clean） */
const KEYWORDS = [
  ['clear', 'pcb-clearance'],
  ['stitch', 'pcb-stitched'],
  ['patch', 'pcb-patched'],
  ['drc', 'pcb-drc'],
  ['rout', 'pcb-routed'],
  ['pour', 'pcb-pour'],
  ['layout', 'pcb-layout'],
  ['import', 'pcb-imported'],
  ['sch', 'sch-wired'],
];

/** 1080x1920 成片抽帧里，EDA 画布所在的 y 区间（上方标题/下方图例已在画外）
 *  仅在 source=stills 且图正好 1080x1920 时启用，纯占位用途。 */
const STILL_CROP = [240, 940];

/** 从 PNG 头里读宽高（IHDR 固定在第 16..24 字节），不引入任何图片库 */
function pngSize(file) {
  try {
    const buf = Buffer.alloc(24);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, 24, 0);
    } finally {
      fs.closeSync(fd);
    }
    const sig = buf.subarray(0, 8).toString('hex');
    if (sig !== '89504e470d0a1a0a') return null;
    if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch {
    return null;
  }
}

const listPngs = (dir) => {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => /\.png$/i.test(n))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  } catch {
    return [];
  }
};

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** 最新一个时间戳目录（名字倒序，跳过 _ / . 开头的临时目录，必须有 png） */
function findLatestFrameDir() {
  let entries = [];
  try {
    entries = fs.readdirSync(FRAMES_ROOT, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = entries
    .filter((d) => d.isDirectory() && !/^[_.]/.test(d.name))
    .map((d) => {
      const full = path.join(FRAMES_ROOT, d.name);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {
        /* ignore */
      }
      return { name: d.name, full, mtime, pngs: listPngs(full) };
    })
    .filter((d) => d.pngs.length > 0)
    // 时间戳目录名（HHmmss / 日期串）字典序即时间序；同日同名再比 mtime
    .sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true }) || b.mtime - a.mtime);
  return dirs[0] || null;
}

const baseName = (f) => path.basename(f, path.extname(f));

/** 0000-sch-wired.png → sch-wired；f460.png → f460 */
function tagOf(file) {
  const b = baseName(file);
  const m = b.match(/^\d+\s*[-_.]\s*(.+)$/);
  return (m ? m[1] : b).trim();
}

function stageOf(tag, index, total) {
  const t = String(tag || '').toLowerCase();
  if (STAGES[t]) return { key: t, ...STAGES[t], matched: 'exact' };
  for (const [kw, key] of KEYWORDS) {
    if (t.includes(kw)) return { key, ...STAGES[key], matched: 'keyword' };
  }
  // 认不出来的 tag（占位抽帧 / 未来新增里程碑）：按序号铺满全流程，标题始终有中文可读
  const pos = total <= 1 ? 0 : Math.round((index * (STAGE_ORDER.length - 1)) / (total - 1));
  const key = STAGE_ORDER[pos];
  return { key, ...STAGES[key], matched: 'positional' };
}

/** 硬链接（同一分区几乎零成本），跨卷或权限问题退回复制 */
function place(src, dst) {
  try {
    fs.rmSync(dst, { force: true });
  } catch {
    /* ignore */
  }
  try {
    fs.linkSync(src, dst);
  } catch {
    fs.copyFileSync(src, dst);
  }
}

function build() {
  // manifest 已经是裸数组 = frames-to-v7.mjs 挑好的真实录制帧清单：
  // 原样保留，不重扫、不清 public/v7/img、不覆盖（数组长度就是 PcbRealV7 的段数）。
  const existing = readManifest();
  if (existing && existing.shape === 'array') {
    // 有新录制帧但没重跑转换器时提醒一句（stderr，remotion.config.js 会透出来）
    let stale = false;
    try {
      const latest = findLatestFrameDir();
      if (latest) stale = fs.statSync(latest.full).mtimeMs > fs.statSync(MANIFEST).mtimeMs;
    } catch {
      /* ignore */
    }
    if (stale) {
      console.warn('[v7] out/frames 下有比 manifest 更新的录制帧，但 manifest 是数组形状（未覆盖）；要用新帧请重跑 video/scripts/frames-to-v7.mjs');
    }
    return {
      source: 'real',
      sourceDir: '',
      count: existing.items.length,
      items: existing.items,
      kept: true,
      shape: 'array',
      stale,
    };
  }

  fs.mkdirSync(IMG_DIR, { recursive: true });

  const latest = findLatestFrameDir();
  let source = 'none';
  let sourceDir = '';
  let files = [];

  if (latest) {
    source = 'frames';
    sourceDir = latest.full;
    files = latest.pngs.map((n) => ({ full: path.join(latest.full, n), name: n }));
  } else {
    const stills = listPngs(STILLS_DIR);
    if (stills.length) {
      source = 'stills';
      sourceDir = STILLS_DIR;
      files = stills.map((n) => ({ full: path.join(STILLS_DIR, n), name: n }));
    }
  }

  // 清掉上一轮同步过去的图，避免旧帧残留
  for (const n of listPngs(IMG_DIR)) {
    try {
      fs.rmSync(path.join(IMG_DIR, n), { force: true });
    } catch {
      /* ignore */
    }
  }

  const total = files.length;
  const items = files.map((f, i) => {
    const tag = tagOf(f.name);
    const st = stageOf(tag, i, total);
    const size = pngSize(f.full) || { w: 0, h: 0 };
    const crop =
      source === 'stills' && size.w === 1080 && size.h === 1920 ? STILL_CROP.slice() : null;
    const safe = `${String(i).padStart(4, '0')}-${tag.replace(/[^\w.-]+/g, '_') || 'frame'}.png`;
    place(f.full, path.join(IMG_DIR, safe));
    return {
      file: `v7/img/${safe}`,
      src: f.name,
      tag,
      stage: st.key,
      label: st.label,
      sub: st.sub,
      matched: st.matched,
      w: size.w,
      h: size.h,
      crop,
      placeholder: source !== 'frames',
    };
  });

  const manifest = {
    generatedAt: new Date().toISOString(),
    source, // frames = EDA 真实渲染帧（正片）｜stills = 成片抽帧（占位）｜none = 无素材
    sourceDir,
    count: items.length,
    items,
  };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

export function prepare({ quiet = true } = {}) {
  try {
    const m = build();
    if (!quiet) {
      console.log(`[v7] source=${m.source} count=${m.count} dir=${m.sourceDir || '-'}${m.kept ? ' (保留 frames-to-v7 的数组 manifest，未重扫)' : ''}`);
      for (const it of m.items) {
        // 数组 manifest 的元素没有 matched 字段（由 frames-to-v7 标注 why=tag/sample）
        console.log(`     ${it.file}  ${it.tag} → ${it.label || it.stage || '-'} (${it.matched || it.why || 'real'}) ${it.w || '?'}x${it.h || '?'}`);
      }
    }
    return m;
  } catch (err) {
    // 绝不把异常抛给 remotion.config.mjs：老合成必须照常能跑
    console.warn('[v7] prepare 跳过（保留上一版 manifest）：', err && err.message ? err.message : err);
    return null;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepare({ quiet: false });
}
