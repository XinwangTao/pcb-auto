#!/usr/bin/env node
/**
 * attach-motion.mjs · 把「真实运动片段」挂到 manifest 的对应段上
 *
 * 背景：用户不要图片切换，要**真实操作的运动画面**，而且要能看出"快"。
 * build-v11.mjs 产的是**静态画布帧**（EDA 自己渲染的 milestone 截图），
 * 那是"里程碑照片"，不是"过程"。
 * 这里把 cut-motion.ps1 切出来的运动片段挂到 beats[].video 上，
 * 合成（PcbRealV11.jsx）看到 video 就渲染视频而不是图片。
 *
 * 关键设计：**倍速在 ffmpeg 里已经烘进文件了**（setpts），运行时 playbackRate 恒为 1。
 * 所以屏幕上写的 "32×" 与文件实际时长严格自洽 —— 不是运行时再变速那种"数字和画面
 * 两套账"的做法。srcWindowSec / speed / outDurSec 三个数必须自洽：
 *   |outDurSec - srcWindowSec/speed| < 0.05 s
 *
 * 视频段要覆盖掉图片段的几何：crop/srcW/srcH 换成视频的真实宽高，
 * 否则 Plate 会按旧截图的宽高比去摆，画面被拉扁。
 *
 * 用法：node video/scripts/attach-motion.mjs [--clips <clips.json>] [--dry]
 * 退出码：0 成功 / 2 缺输入 / 1 断言失败
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIDEO_DIR = path.resolve(HERE, '..');
const MANIFEST = path.join(VIDEO_DIR, 'public', 'v11', 'manifest.json');
const BACKUP = path.join(VIDEO_DIR, 'public', 'v11', 'manifest.stills.json');
const DEFAULT_CLIPS = path.join(VIDEO_DIR, 'out', 'motion', 'clips.json');

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const DRY = argv.includes('--dry');
const CLIPS = argOf('--clips') || DEFAULT_CLIPS;

const die = (msg, code) => { console.error(`[motion] 错误：${msg}`); process.exit(code); };
const log = (...a) => console.log('[motion]', ...a);

if (!fs.existsSync(CLIPS)) die(`缺运动片段清单：${CLIPS}（先跑 video/scripts/cut-motion.ps1）`, 2);
if (!fs.existsSync(MANIFEST)) die(`缺 manifest：${MANIFEST}（先跑 build-v11.mjs）`, 2);

const clipsDoc = JSON.parse(fs.readFileSync(CLIPS, 'utf8'));
const clips = Array.isArray(clipsDoc.clips) ? clipsDoc.clips : [];
if (!clips.length) die('clips.json 里没有片段', 2);

// 每份 manifest 只备份一次静态版，免得反复跑把备份覆盖成已经挂了视频的版本
if (!fs.existsSync(BACKUP) && !DRY) {
  fs.copyFileSync(MANIFEST, BACKUP);
  log(`已备份静态版 → ${path.relative(VIDEO_DIR, BACKUP)}`);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
if (!Array.isArray(manifest.beats) || !manifest.beats.length) die('manifest 没有 beats', 2);

const problems = [];
let attached = 0;
for (const c of clips) {
  const beat = manifest.beats.find((b) => b.id === c.beat);
  if (!beat) { problems.push(`clips.json 里的 beat「${c.beat}」在 manifest 里不存在`); continue; }

  // 片段由 cut-motion.ps1 落在 out\\motion\\（证据侧），这里复制到 public\\v11motion\\（素材侧）。
  // Remotion 的 staticFile 只认 public，放错位置的后果是渲染时才报找不到文件。
  const clipSrc = path.join(VIDEO_DIR, 'out', 'motion', path.basename(c.outFile));
  const clipPath = path.join(VIDEO_DIR, 'public', c.outFile);
  if (!fs.existsSync(clipSrc)) { problems.push(`片段源文件不存在：${path.basename(c.outFile)}（先跑 cut-motion.ps1）`); continue; }
  if (!DRY) {
    fs.mkdirSync(path.dirname(clipPath), { recursive: true });
    fs.copyFileSync(clipSrc, clipPath);
  }

  // 三个数必须自洽：烘进文件的倍速 ≠ 清单里写的倍速，屏幕上那个「32×」就是假的
  const expect = c.srcWindowSec / c.speed;
  if (Math.abs(c.outDurSec - expect) > 0.05) {
    problems.push(`${c.name}: outDurSec=${c.outDurSec} 与 srcWindowSec/speed=${expect.toFixed(3)} 不符`);
    continue;
  }
  if (!(c.speed > 1)) { problems.push(`${c.name}: speed=${c.speed} 不大于 1（那不叫加速）`); continue; }
  if (c.firstLastDiffer !== true) { problems.push(`${c.name}: firstLastDiffer 不是 true，疑似静止冒充运动`); continue; }

  beat.video = {
    file: c.outFile,
    speed: c.speed,
    srcFile: c.srcFile,
    srcStart: c.srcStart,
    srcWindowSec: c.srcWindowSec,
    outDurSec: c.outDurSec,
    outFrames: c.outFrames,
  };
  // 覆盖几何：视频与截图的宽高比不同，不换 crop 会被拉扁
  beat.crop = { x: 0, y: 0, w: c.w, h: c.h };
  beat.srcW = c.w;
  beat.srcH = c.h;
  beat.why = `真实屏录 ${c.srcFile} 第 ${c.srcStart}s 起 ${c.srcWindowSec}s，${c.speed}× 加速后 ${c.outDurSec}s`;
  // 【橙色说明行必须跟着变】它原本是“画布在 6–56 秒之间变了 2 次”，
  // 那是**静态截图时代**的描述。现在画面真在运动，继续写那句会与屏幕上的
  // “${c.speed}×”直接矛盾 —— 一个数字两种含义。
  if (beat.sub) beat.sub = `${c.srcWindowSec.toFixed(1)} 秒真实操作，${c.speed}× 加速`;
  attached++;
}

if (problems.length) {
  log('问题：');
  for (const p of problems) log('  - ' + p);
}

const totalSpeedWeighted = manifest.beats.filter((b) => b.video).length;
log(`挂上运动片段的段数 = ${attached} / manifest 段数 ${manifest.beats.length}`);
const stills = manifest.beats.filter((b) => !b.video && Array.isArray(b.frames) && b.frames.length);
log(`仍为静态帧的段 = ${stills.length}（${stills.map((b) => b.id).join(', ') || '无'}）`);

// 断言：至少一半的段是**运动**，否则这片子还是"图片切换"
const need = Math.ceil(manifest.beats.length / 2);
if (attached < need) die(`只有 ${attached} 段是运动画面（要求 ≥ ${need}）—— 用户明确不要图片切换`, 1);

if (DRY) { log('（--dry，不写盘）'); process.exit(0); }

manifest.source = manifest.source || {};
manifest.source.motion = {
  clipsFile: path.relative(VIDEO_DIR, CLIPS).replace(/\\/g, '/'),
  attached,
  stillBeats: stills.map((b) => b.id),
  generatedAt: clipsDoc.generatedAt || null,
};
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1), 'utf8');
log(`已写 ${path.relative(VIDEO_DIR, MANIFEST)}`);
process.exit(problems.length ? 1 : 0);
