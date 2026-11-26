#!/usr/bin/env node
/**
 * build-v10.mjs · 为 PcbRealV10 挑帧、复制素材、写 manifest
 *
 * 一句话：把 `out/frames/<批次>/<尝试>/*.png`（流水线让 EDA 自己渲染画布落的真实帧）
 * 挑成十几段，每段 1–5 张按时间顺序连播，写 `video/public/v10/manifest.json`。
 *
 * 两步（第一步是量测，第二步才是本脚本）：
 *   python video\scripts\frames-stats.py out\frames\140310 out\frames\171654 ^
 *       out\frames\175901 out\frames\185013 out\frames\192608 --out video\data\frames-stats.json
 *   node video\scripts\build-v10.mjs
 *
 * 为什么必须先量测：这批帧里有两类"看起来正常、其实没用"的帧，
 *   1) **空画布**：`0000-sch-wired.png` 整张没有一块彩色的板（coloredRatio=0）。
 *      它会被当成"加载中"播过去，不报错。本脚本直接拒绝。
 *   2) **字节重复**：实测 `140310/1-smart-fit` 的 140 张 PNG 只有 38 张是不同画面；
 *      `175901/1-smart-fit` 的 route-t39s/t163s/t288s/t403s **四张 sha256 完全相同**。
 *      按文件名挑"进度帧"会挑出 4 张一模一样的图，看着像卡住了。
 *      所以段内按住 sha256 去重，只有画面真的变了才进时间线。
 *
 * 硬约束（脚本内断言，违反就退 1）：
 *   1) 段内同批次、同尝试、序号严格递增 —— 否则时间线会倒流；
 *   2) 段顺序按 (批次时间戳, 尝试号, 首个帧序号) 单调递增 —— 185013 的 4 次尝试各自连续，
 *      绝不按文件名全局混排（`1-…/0033` 和 `2-…/0000` 混排会让画面从"走完"退回"刚导入"）；
 *   3) 每张帧文件真实存在、PNG 头里宽高 > 0、不是空画布。
 *
 * 退出码：0 正常 / 2 缺输入（stats 或帧目录）/ 1 断言失败
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // …\video\scripts
const VIDEO_DIR = path.resolve(HERE, '..');
const REPO_DIR = path.resolve(VIDEO_DIR, '..');
const OUT_FRAMES = path.join(REPO_DIR, 'out', 'frames');
const OUT_RUNS = path.join(REPO_DIR, 'out');
const STATS_FILE = path.join(VIDEO_DIR, 'data', 'frames-stats.json');
const PUBLIC_V10 = path.join(VIDEO_DIR, 'public', 'v10');
const IMG_DIR = path.join(PUBLIC_V10, 'img');
const MANIFEST = path.join(PUBLIC_V10, 'manifest.json');

const log = (...a) => console.log('[v10]', ...a);
const die = (msg) => {
  console.error(`[v10] 错误：${msg}`);
  process.exit(msg.startsWith('缺') ? 2 : 1);
};

/* ------------------------------------------------------------------ 段表 */

/**
 * 成片顺序 = 真实录制时间顺序。
 *   批次按 HHmmss 时间戳：140310(14:03) → 171654(17:16) → 175901(17:59) → 185013(18:50) → 192608(19:26)
 *   同批次按尝试号：1-smart-fit → 2-expand-1.25x → 3-retry → 4-retry2（各自连续，绝不混排）
 *
 * `frames` 显式列 = 里程碑帧；`auto` = 在某阶段里按 sha256 去重后等间隔取 k 张。
 * 数字（DRC 组数 / 导出数 / 耗时）**不手写**，由 _run-<attempt>.json 现读现拼。
 */
const BEATS = [
  {
    id: 'a1',
    batch: '140310',
    attempt: '1-smart-fit',
    title: '网表进 PCB',
    sub: '一导入全是飞线，一条还没走',
    why: 'pcb-imported 帧：器件已落板框，蓝色飞线全部未布',
    frames: ['0001-pcb-imported'],
  },
  {
    id: 'a2',
    batch: '140310',
    attempt: '1-smart-fit',
    title: '自动布局',
    sub: '器件自己挪开，板框定下来',
    why: 'layout-t6s / t14s / t23s → pcb-layout：布局阶段的 4 个真实时刻',
    frames: ['0002-layout-t6s', '0003-layout-t14s', '0004-layout-t23s', '0005-pcb-layout'],
  },
  {
    id: 'a3',
    batch: '140310',
    attempt: '1-smart-fit',
    title: '覆铜',
    sub: '铜面整片铺上，GND 连成一片',
    why: 'pcb-pour 帧：整板红色铜面',
    frames: ['0006-pcb-pour'],
  },
  {
    id: 'a4',
    batch: '140310',
    attempt: '1-smart-fit',
    title: '布线器在走线',
    sub: '同一段布线，画布真的在变',
    why: '布线阶段的画面（按 sha256 去重后等间隔取 5 张，秒数戳跨 t6s → t7xx）',
    auto: { match: '^route-', k: 5 },
  },
  {
    id: 'a5',
    batch: '140310',
    attempt: '1-smart-fit',
    title: '布通',
    sub: '飞线走完，只剩收尾',
    why: 'pcb-routed 帧：布通瞬间的画布',
    frames: ['0134-pcb-routed'],
  },
  {
    id: 'a6',
    batch: '140310',
    attempt: '1-smart-fit',
    title: '翻到底层',
    sub: '换个层看，走线压在铜面上',
    why: 'pcb-bottom 帧：EDA 自己切的底层视图',
    frames: ['0135-pcb-bottom'],
  },
  {
    id: 'a7',
    batch: '140310',
    attempt: '1-smart-fit',
    title: '补线 → 间距 → 兜底 → DRC',
    sub: '最后几屏全是修，不是画',
    why: 'pcb-stitched / clearance / patched / drc：收尾 4 个里程碑帧',
    frames: ['0136-pcb-stitched', '0137-pcb-clearance', '0138-pcb-patched', '0139-pcb-drc'],
  },
  {
    id: 'b1',
    batch: '171654',
    attempt: '1-smart-fit',
    title: '换一块板：第 1 次',
    sub: '竖长板框，密度高一截',
    why: '171654 第 1 次尝试：route2 → 布通 → DRC',
    frames: ['0004-route2-t6s', '0008-route2-t38s', '0009-pcb-routed', '0014-pcb-drc'],
  },
  {
    id: 'b2',
    batch: '171654',
    attempt: '4-expand-1.25x-retry2',
    title: '同板第 4 次：板框放大 1.25 倍',
    sub: '重试不是重画，是改板框再走',
    why: '171654 第 4 次尝试：板框扩到 1625×4625mil 之后的布线到 DRC',
    frames: ['0008-route-t6s', '0019-route-t96s', '0022-pcb-routed', '0027-pcb-drc'],
  },
  {
    id: 'c1',
    batch: '175901',
    attempt: '1-smart-fit',
    title: '同一次布线，403 秒',
    sub: '只留下画面真的变了的几帧',
    why: '175901 第 1 次尝试的布线阶段（route 帧按 sha256 去重，很多秒数戳的图其实一模一样）',
    auto: { match: '^route-', k: 5 },
  },
  {
    id: 'c2',
    batch: '175901',
    attempt: '2-expand-1.25x',
    title: '放到 1.25 倍再走一遍',
    sub: '布局没变，板框宽了 325mil',
    why: '175901 第 2 次尝试：expanded 板框后的布线中段 → 布通',
    frames: ['0008-route-t6s', '0014-route-t57s', '0018-route-t89s', '0043-pcb-routed'],
  },
  {
    id: 'd1',
    batch: '185013',
    attempt: '1-smart-fit',
    title: 'V4 第 1 次',
    sub: '覆铜之后走线，违规只剩 5 组',
    why: '185013 第 1 次尝试：覆铜 / 布线中段 / DRC 画布',
    frames: ['0003-pcb-pour', '0008-route-t6s', '0015-route-t62s', '0033-pcb-drc'],
  },
  {
    id: 'd2',
    batch: '185013',
    attempt: '2-expand-1.25x',
    title: 'V4 第 2 次：扩板框',
    sub: '违规组数没变，板框大了 25%',
    why: '185013 第 2 次尝试：布线 / 布通 / DRC',
    frames: ['0015-route-t56s', '0030-pcb-routed', '0035-pcb-drc'],
  },
  {
    id: 'd3',
    batch: '185013',
    attempt: '3-expand-1.25x-retry',
    title: 'V4 第 3 次：更差了',
    sub: '违规 5 → 8 组，还多出 14 条错',
    why: '185013 第 3 次尝试：_run 里 errors 14 / mismatches 12，是 4 次里最差的一次',
    frames: ['0001-pcb-imported', '0014-route-t46s', '0021-pcb-routed', '0026-pcb-drc'],
  },
  {
    id: 'd4',
    batch: '185013',
    attempt: '4-expand-1.25x-retry2',
    title: 'V4 第 4 次：回到 5 组',
    sub: '重试阶梯走完，还是没过',
    why: '185013 第 4 次尝试：回到 5 组违规，DRC 仍未通过',
    frames: ['0015-route-t54s', '0026-pcb-routed', '0031-pcb-drc'],
  },
];

/**
 * 在建批次：**读盘时刻**有什么用什么，取最后几张（tail）。
 *
 * 旧版本这里写死了 `192608/1-smart-fit`，结果两个问题：
 *   ① 批次会往前推进（192608 后来进了第 2 次尝试、193938 接着起来），写死的那一段会变成"旧的"；
 *   ② 用"第 1 次尝试"还是"最后一次尝试"要现判，不能靠人盯着。
 * 现在：每批取**PNG 最多的那个尝试目录**（最早的尝试通常已写满，后续尝试还在长），
 * 批次之间按时间戳升序 —— 时间线仍然只往前走。
 */
const INFLIGHT = [
  {
    id: 'e1',
    batch: '192608',
    title: 'V4 的另一轮，此刻还在跑',
    tail: 3,
  },
  {
    id: 'e2',
    batch: '193938',
    title: '刚起跑的 V5',
    sub: '多两颗去耦、C5 挪到 U3 旁边',
    tail: 3,
  },
];

/* ------------------------------------------------------------------ 工具 */

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

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

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const idxOf = (name) => Number((name.match(/^(\d+)/) || [0, -1])[1]);
/** "3-expand-1.25x-retry" → 3。文件名序号和尝试号都是「时间上更早的更小」。 */
const attemptNo = (a) => Number.parseInt(String(a).match(/^(\d+)-/)?.[1] ?? '0', 10);

/** 等间隔下采样（保留首尾） */
function downsample(list, n) {
  if (list.length <= n) return list.slice();
  if (n === 1) return [list[Math.floor((list.length - 1) / 2)]];
  const out = [];
  const seen = new Set();
  for (let k = 0; k < n; k++) {
    const it = list[Math.round((k * (list.length - 1)) / (n - 1))];
    if (!seen.has(it)) {
      seen.add(it);
      out.push(it);
    }
  }
  for (const it of list) {
    if (out.length >= n) break;
    if (!seen.has(it)) {
      seen.add(it);
      out.push(it);
    }
  }
  return out;
}

function runDirOf(batch) {
  const hits = fs
    .readdirSync(OUT_RUNS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.endsWith(`-${batch}`))
    .map((e) => path.join(OUT_RUNS, e.name));
  return hits.length ? hits.sort().pop() : null;
}

function runFacts(runDir, attempt) {
  if (!runDir) return { available: false, why: '找不到对应的 out/<run> 目录' };
  const file = path.join(runDir, `_run-${attempt}.json`);
  if (!fs.existsSync(file)) return { available: false, why: `没有 _run-${attempt}.json（该次可能仍在跑）` };
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const g = j.gates || {};
  return {
    available: true,
    runFile: path.relative(REPO_DIR, file).replace(/\\/g, '/'),
    design: path.basename(runDir).replace(/-\d{8}-\d{6}$/, ''),
    board: `${j.boardWidthMil}×${j.boardHeightMil}`,
    drcPassed: !!g.drcPassed,
    drcLeaf: g.drcLeafCount,
    drcTotal: g.drcTotalCount,
    errors: g.errors,
    mismatches: g.mismatches,
    exportsOk: g.exportsOk,
    elapsedS: Math.round((j.elapsedMs || 0) / 1000),
  };
}

function factLine(f) {
  if (!f.available) return `运行数据：${f.why}`;
  const drc = f.drcPassed ? 'DRC 通过' : `DRC 未过 ${f.drcLeaf}/${f.drcTotal} 组`;
  return `${f.design} · 板框 ${f.board}mil · ${drc} · 错误 ${f.errors} · 不匹配 ${f.mismatches} · 导出 ${f.exportsOk}/6 · ${f.elapsedS}s`;
}

/* ------------------------------------------------------------------ 主流程 */

function main() {
  if (!fs.existsSync(STATS_FILE)) {
    die(
      `缺 ${path.relative(REPO_DIR, STATS_FILE)}。先生成量测：\n` +
        `  python video\\scripts\\frames-stats.py out\\frames\\140310 out\\frames\\171654 out\\frames\\175901 out\\frames\\185013 out\\frames\\192608 --out video\\data\\frames-stats.json`,
    );
  }
  if (!isDir(OUT_FRAMES)) die(`缺 out/frames 目录：${OUT_FRAMES}`);

  const stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  const st = new Map(); // "<batch>/<attempt>/<名>.png" → 量测（attempt 可能为空）
  for (const r of stats) {
    const batch = path.basename(r.dir);
    st.set(`${batch}/${r.rel}`, r);
  }

  const problems = [];
  const beats = [];
  let scannedPng = 0;
  let distinctAll = 0;
  const distinctByAttempt = {};

  /* 每段的候选池：显式名单 / 正则，再按 sha256 去重 */
  function collect(beat) {
    const dir = path.join(OUT_FRAMES, beat.batch, beat.attempt);
    if (!isDir(dir)) {
      problems.push(`帧目录不存在：${dir}`);
      return null;
    }
    const all = fs
      .readdirSync(dir)
      .filter((n) => /\.png$/i.test(n))
      .sort((a, b) => idxOf(a) - idxOf(b) || a.localeCompare(b, 'en'));
    scannedPng += all.length;

    /* 整目录去重统计（用来在报告里说"多少张是真不同的画面"） */
    const key = `${beat.batch}/${beat.attempt}`;
    if (distinctByAttempt[key] === undefined) {
      const h = new Set();
      for (const n of all) h.add(sha(path.join(dir, n)));
      distinctByAttempt[key] = { files: all.length, distinct: h.size };
      distinctAll += h.size;
    }

    let names;
    let note = '';
    if (beat.frames) {
      names = beat.frames.map((f) => `${f}.png`);
      const missing = names.filter((n) => !all.includes(n));
      if (missing.length) {
        problems.push(`段 ${beat.id} 引用的帧不存在：${missing.join(', ')}`);
        return null;
      }
    } else if (beat.auto) {
      const re = new RegExp(beat.auto.match);
      names = all.filter((n) => re.test(n.replace(/\.png$/i, '').replace(/^\d+-/, '')));
      note = `自动挑帧：${beat.auto.match} 命中 ${names.length} 张，去重后等间隔取 ${beat.auto.k} 张`;
    } else {
      problems.push(`段 ${beat.id} 既没有 frames 也没有 auto`);
      return null;
    }

    /* 只保留能用的（有板、PNG 头正常），再按住 sha256 去重 */
    const usable = [];
    let dupes = 0;
    for (const n of names) {
      const rel = path.relative(dir, path.join(dir, n)).replace(/\\/g, '/');
      const r = st.get(`${beat.batch}/${rel}`) || st.get(`${beat.batch}/${beat.attempt}/${n}`);
      const src = path.join(dir, n);
      if (!r) {
        problems.push(`统计里没有这帧：${beat.batch}/${beat.attempt}/${n}（先重跑 frames-stats.py）`);
        continue;
      }
      if (!r.bbox || r.coloredRatio <= 0.0005) {
        problems.push(`空画布帧（coloredRatio=${r.coloredRatio}）：${src}`);
        continue;
      }
      const size = pngSize(src);
      if (!size || !size.w || !size.h) {
        problems.push(`PNG 头读不出宽高：${src}`);
        continue;
      }
      usable.push({ name: n, tag: n.replace(/\.png$/i, '').replace(/^\d+-/, ''), idx: idxOf(n), src, size, s: r, hash: sha(src) });
    }

    /* 去重：**全局**按 sha256 保留首次出现，不是只去相邻重复。
       只去相邻的话，等间隔抽样仍可能抽到两张同一个画面（实测 a4 抽到
       `0105-route-t14s` 与 `0010-route-t6s` 字节相同 → 成片里那一段像卡住）。 */
    const seenHash = new Set();
    const dedup = [];
    for (const f of usable) {
      if (seenHash.has(f.hash)) {
        dupes++;
        continue;
      }
      seenHash.add(f.hash);
      dedup.push(f);
    }
    if (dupes) note += `${note ? '；' : ''}段内丢掉 ${dupes} 张与之前画面字节相同的重复帧`;
    if (!dedup.length) {
      problems.push(`段 ${beat.id} 去重后没有可用帧`);
      return null;
    }

    let picked;
    if (beat.auto) picked = downsample(dedup, beat.auto.k);
    else picked = dedup;

    /* 显式段被去重削短要说清楚，不要静默 */
    if (beat.frames && picked.length < beat.frames.length) {
      note += `${note ? '；' : ''}显式列了 ${beat.frames.length} 张，去重后只剩 ${picked.length} 张不同画面`;
    }
    return { picked, note };
  }

  for (const beat of BEATS) {
    const got = collect(beat);
    if (!got) continue;
    /* 段内断言：同批次同尝试、序号严格递增 */
    const idxs = got.picked.map((p) => p.idx);
    for (let i = 1; i < idxs.length; i++) {
      if (!(idxs[i] > idxs[i - 1])) problems.push(`段 ${beat.id} 帧序号不是递增：${idxs[i - 1]} → ${idxs[i]}`);
    }
    beats.push({ beat, picked: got.picked, note: got.note });
  }

  /* 在建批次：读盘时刻最后一次列目录，每批取 PNG 最多的尝试，再取最后 tail 张不同画面 */
  const inflightInfo = [];
  for (const spec of INFLIGHT) {
    const batchDir = path.join(OUT_FRAMES, spec.batch);
    if (!isDir(batchDir)) {
      log(`在建批次 ${spec.batch} 目录不存在，跳过这一段（不编造）`);
      continue;
    }
    /* 选 PNG 最多的尝试目录：早的尝试已写满，后来推进的尝试还在长 */
    const attempts = fs
      .readdirSync(batchDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, n: fs.readdirSync(path.join(batchDir, e.name)).filter((f) => /\.png$/i.test(f)).length }))
      .sort((a, b) => b.n - a.n || attemptNo(a.name) - attemptNo(b.name));
    if (!attempts.length || attempts[0].n === 0) {
      log(`在建批次 ${spec.batch} 还没有 PNG，跳过这一段（不编造）`);
      continue;
    }
    const attempt = attempts[0].name;
    const dir = path.join(batchDir, attempt);
    const all = fs
      .readdirSync(dir)
      .filter((n) => /\.png$/i.test(n))
      .sort((a, b) => idxOf(a) - idxOf(b) || a.localeCompare(b, 'en'));
    const usable = [];
    for (const n of all) {
      const r = st.get(`${spec.batch}/${attempt}/${n}`) || st.get(`${spec.batch}/${n}`);
      const src = path.join(dir, n);
      if (!r || !r.bbox || r.coloredRatio <= 0.0005) continue;
      const size = pngSize(src);
      if (!size || !size.w || !size.h) continue;
      usable.push({ name: n, tag: n.replace(/\.png$/i, '').replace(/^\d+-/, ''), idx: idxOf(n), src, size, s: r, hash: sha(src) });
    }
    /* 去掉重复画面（全局按 sha256） */
    const seenHash = new Set();
    const dedup = [];
    for (const f of usable) {
      if (seenHash.has(f.hash)) continue;
      seenHash.add(f.hash);
      dedup.push(f);
    }
    /* 在建批次的帧也要进总量，否则 manifest 里的 scannedPng 只数了 4 个跑完的批次，
       读起来像"这批帧不在统计里"。分开记一份，合计数才是真分母。 */
    scannedPng += all.length;
    distinctAll += dedup.length;
    inflightInfo.push({
      batch: spec.batch,
      attempt,
      attemptCounts: attempts.map((a) => `${a.name}:${a.n}`),
      filesOnDisk: all.length,
      usable: usable.length,
      distinct: dedup.length,
      snapshotAt: new Date().toISOString(),
    });
    if (dedup.length >= 2) {
      const picked = dedup.slice(-spec.tail);
      beats.push({
        beat: { ...spec, attempt },
        picked,
        note: `在建批次快照：${attempt} 磁盘上 ${all.length} 张（各尝试 ${attempts.map((a) => `${a.name}=${a.n}`).join(' / ')}），可用 ${usable.length} 张，不同画面 ${dedup.length} 张，取最后 ${picked.length} 张`,
      });
    } else {
      log(`在建批次 ${spec.batch} 可用帧只有 ${dedup.length} 张，跳过这一段（不编造）`);
    }
  }

  if (problems.length) {
    console.error('[v10] 断言失败：');
    for (const p of problems) console.error('   !', p);
    process.exit(1);
  }

  /* 段顺序：按 (批次, 尝试号, 首帧序号) 单调递增 */
  let prev = null;
  for (const b of beats) {
    const key = [b.beat.batch, attemptNo(b.beat.attempt), b.picked[0].idx];
    if (
      prev &&
      (key[0] < prev[0] ||
        (key[0] === prev[0] && key[1] < prev[1]) ||
        (key[0] === prev[0] && key[1] === prev[1] && key[2] < prev[2]))
    ) {
      die(`段顺序倒流：${b.beat.batch}/${b.beat.attempt}/#${key[2]} 排在 ${prev.join('/')} 之后（4 次尝试必须各自连续）`);
    }
    prev = key;
  }

  /* 清旧图 + 复制 */
  fs.mkdirSync(IMG_DIR, { recursive: true });
  for (const n of fs.readdirSync(IMG_DIR)) if (/\.png$/i.test(n)) fs.rmSync(path.join(IMG_DIR, n), { force: true });

  const runCache = new Map();
  const getRun = (batch, attempt) => {
    const k = `${batch}/${attempt}`;
    if (!runCache.has(k)) runCache.set(k, runFacts(runDirOf(batch), attempt));
    return runCache.get(k);
  };

  const out = [];
  beats.forEach((b) => {
    const { beat, picked, note } = b;
    const s0 = picked[0].s;
    const W = s0.w;
    const H = s0.h;
    /* 裁切框：取段内 bbox 中位数再外扩，保证段内画面不跳 */
    const mx0 = median(picked.map((p) => p.s.bbox[0]));
    const my0 = median(picked.map((p) => p.s.bbox[1]));
    const mx1 = median(picked.map((p) => p.s.bbox[2]));
    const my1 = median(picked.map((p) => p.s.bbox[3]));
    const bw = (mx1 - mx0) * W;
    const bh = (my1 - my0) * H;
    const padX = Math.max(18, bw * 0.22);
    const padY = Math.max(14, bh * 0.09);
    const cx0 = Math.max(0, Math.round(mx0 * W - padX));
    const cy0 = my0 < 0.12 ? 0 : Math.max(0, Math.round(my0 * H - padY));
    const cx1 = Math.min(W, Math.round(mx1 * W + padX));
    const cy1 = Math.min(H, Math.round(my1 * H + padY));
    const crop = { x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0 };

    const frames = picked.map((p, k) => {
      const dstName = `${beat.id}-${String(k + 1).padStart(2, '0')}.png`;
      fs.copyFileSync(p.src, path.join(IMG_DIR, dstName));
      return {
        file: `v10/img/${dstName}`,
        src: `${beat.batch}/${beat.attempt}/${p.name}`,
        tag: p.tag,
        idx: p.idx,
        w: p.size.w,
        h: p.size.h,
      };
    });

    out.push({
      id: beat.id,
      batch: beat.batch,
      attempt: beat.attempt,
      title: beat.title,
      sub: beat.sub,
      why: beat.why,
      pickNote: note,
      crop,
      srcW: W,
      srcH: H,
      run: getRun(beat.batch, beat.attempt),
      frames,
    });
  });

  const manifest = {
    generatedAt: new Date().toISOString(),
    generator: 'video/scripts/build-v10.mjs',
    source: {
      framesRoot: 'out/frames',
      statsFile: path.relative(REPO_DIR, STATS_FILE).replace(/\\/g, '/'),
      statsTool: 'video/scripts/frames-stats.py（彩色像素 bbox + 亮度；只读 out/frames）',
      scannedPng,
      distinctImages: distinctAll,
      byAttempt: distinctByAttempt,
      inflight: inflightInfo,
      note: '帧全部来自流水线在里程碑调 EDA getCurrentRenderedAreaImage() 落的真实画布 PNG；没有任何合成/示意图。',
    },
    beats: out,
  };
  fs.mkdirSync(PUBLIC_V10, { recursive: true });
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 1)}\n`, 'utf8');

  log(`写出 ${path.relative(REPO_DIR, MANIFEST)}：${out.length} 段 / ${out.reduce((n, b) => n + b.frames.length, 0)} 张帧`);
  log(`扫描 ${scannedPng} 张 PNG，其中不同画面 ${distinctAll} 张（字节级去重）`);
  let prevGrp = '';
  out.forEach((b, i) => {
    const grp = `${b.batch}/${b.attempt}`;
    const chg = grp !== prevGrp;
    prevGrp = grp;
    log(`  ${String(i + 1).padStart(2, '0')} ${b.id} ${chg ? `[${grp}]` : ' '.repeat(grp.length + 2)} ${b.title} · ${b.frames.length} 帧 · crop ${b.crop.w}×${b.crop.h}@${b.crop.x},${b.crop.y}`);
    for (const f of b.frames) log(`       ← ${f.src}  (${f.w}×${f.h})`);
    if (b.pickNote) log(`         ${b.pickNote}`);
    log(`         ${factLine(b.run)}`);
  });

  const missing = out.flatMap((b) => b.frames).filter((f) => !fs.existsSync(path.join(VIDEO_DIR, 'public', f.file)));
  if (missing.length) die(`manifest 里有 ${missing.length} 个文件在 public 下找不到：${missing.map((m) => m.file).join(', ')}`);
  const bad = out.flatMap((b) => b.frames).filter((f) => !(f.w > 0 && f.h > 0));
  if (bad.length) die(`有帧宽高为 0：${bad.map((f) => f.src).join(', ')}`);
  /* 同一段的图不能是同一张（去重后仍相同 = 逻辑错） */
  for (const b of out) {
    const h = new Set(b.frames.map((f) => sha(path.join(VIDEO_DIR, 'public', f.file))));
    if (h.size !== b.frames.length) die(`段 ${b.id} 里还有 ${b.frames.length - h.size} 张重复画面`);
  }
  log('自校验通过：文件全部存在、宽高 > 0、段内无重复画面、序号递增、跨段不倒流。');
}

try {
  main();
} catch (e) {
  console.error('[v10] 失败：', e && e.stack ? e.stack : e);
  process.exit(1);
}
