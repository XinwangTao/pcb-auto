#!/usr/bin/env node
/**
 * retime-voice-v11.mjs · 只重算配音的帧位置，不重新合成音频
 *
 * 为什么需要它：把每段从 77 帧拉到 110 帧之后，`timing.json` 里的
 * `startFrame` / `segStart` / `availSec` / `ratio*` 全部作废（它们都按 77 帧算的）。
 * 但**音频文件本身没问题** —— 8 句已经过 silencedetect + atrim 定长、实测 −16.0 LUFS，
 * 重新合成只会把已经验证过的东西再赌一遍（而且 TTS 要联网）。
 *
 * 所以这里只做纯算术：按新的 SEG/XFADE 重排帧位置，并把 tts_v11.py 里那套
 * 不等式**原样搬过来**当断言 —— 两处口径分叉过一次（`SEG=77` 只写在 py 里），
 * 不能再来第二次。
 *
 * 用法：node video/scripts/retime-voice-v11.mjs [--seg 110] [--xfade 10] [--dry]
 * 退出码：0 成功 / 2 缺输入 / 1 断言失败（有句子超出段窗）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIDEO_DIR = path.resolve(HERE, '..');
const TIMING = path.join(VIDEO_DIR, 'public', 'voice_v11', 'timing.json');
const JSX = path.join(VIDEO_DIR, 'src', 'PcbRealV11.jsx');

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? Number(argv[i + 1]) : null; };
const DRY = argv.includes('--dry');
const log = (...a) => console.log('[retime]', ...a);
const die = (m, c) => { console.error(`[retime] 错误：${m}`); process.exit(c); };

const FPS = 30;
const LEAD_SEC = 0.08;

if (!fs.existsSync(TIMING)) die(`缺 ${TIMING}`, 2);
const doc = JSON.parse(fs.readFileSync(TIMING, 'utf8'));
// 【beats 是句数（数字），句子数组在 lines】取值顺序反了一次：
// `doc.beats || doc.lines` 会拿到 8（数字），于是 lines.length 是 undefined，
// 报“没有句子”—— 与真相无关的错误。
const lines = Array.isArray(doc.lines) ? doc.lines : (Array.isArray(doc.beats) ? doc.beats : []);
if (!lines.length) die('timing.json 里没有句子', 2);

// SEG/XFADE 以 JSX 为唯一真源，不接受手填（手填就会分叉）
const jsx = fs.readFileSync(JSX, 'utf8');
const mSeg = jsx.match(/^const SEG = (\d+)/m);
const mXf = jsx.match(/^const XFADE = (\d+)/m);
if (!mSeg || !mXf) die('从 PcbRealV11.jsx 读不到 SEG / XFADE', 2);
const SEG = argOf('--seg') ?? Number(mSeg[1]);
const XFADE = argOf('--xfade') ?? Number(mXf[1]);
if (Number(mSeg[1]) !== SEG) log(`注意：JSX 里 SEG=${mSeg[1]}，本次按 ${SEG} 重算（两者不一致时以本次为准，但请回头把 JSX 改一致）`);

const n = lines.length;
const total = (n - 1) * (SEG - XFADE) + SEG;
const advance = SEG - XFADE;
const segSec = SEG / FPS;
const advanceSec = advance / FPS;
const availSec = advanceSec - LEAD_SEC;
log(`句数 ${n}  SEG=${SEG}  XFADE=${XFADE}  总帧 ${total} = ${(total / FPS).toFixed(3)}s  段推进 ${advanceSec.toFixed(3)}s`);

const problems = [];
let maxRatioAvail = 0, maxRatioSegment = 0;
const out = [];
lines.forEach((it, i) => {
  const dur = Number(it.durSec);
  if (!(dur > 0)) { problems.push(`第 ${i + 1} 句 durSec 无效：${it.durSec}`); return; }
  const startFrame = i * advance + Math.round(LEAD_SEC * FPS);
  const durFrames = Math.ceil(dur * FPS);
  const limit = i < n - 1 ? (i + 1) * advance : total;
  if (startFrame + durFrames > limit) {
    problems.push(`第 ${i + 1} 句占帧 ${startFrame}~${startFrame + durFrames} 越过段界 ${limit}（多 ${startFrame + durFrames - limit} 帧）`);
  }
  const ratioAvail = dur / availSec;
  const ratioSegment = dur / segSec;
  maxRatioAvail = Math.max(maxRatioAvail, ratioAvail);
  maxRatioSegment = Math.max(maxRatioSegment, ratioSegment);
  out.push({
    ...it,
    startSec: +(startFrame / FPS).toFixed(3),
    endSec: +((startFrame + durFrames) / FPS).toFixed(3),
    startFrame,
    durFrames,
    segmentStartSec: +(i * advanceSec).toFixed(3),
    segmentDurSec: +segSec.toFixed(3),
    advanceSec: +advanceSec.toFixed(3),
    availSec: +availSec.toFixed(3),
    ratioAvail: +ratioAvail.toFixed(4),
    ratioSegment: +ratioSegment.toFixed(4),
  });
});

log(`max(句长/段长) = ${maxRatioSegment.toFixed(4)}   max(句长/可用窗) = ${maxRatioAvail.toFixed(4)}`);
for (const o of out) {
  log(`  s${String(o.line).padStart(2, '0')}  帧 ${String(o.startFrame).padStart(4)}~${String(o.startFrame + o.durFrames).padStart(4)}  ${o.durSec.toFixed(3)}s  窗 ${(o.ratioAvail * 100).toFixed(0)}%  「${o.text}」`);
}

if (maxRatioAvail > 1) problems.push(`max(句长/可用窗) = ${maxRatioAvail.toFixed(4)} > 1 —— 有句子装不下`);
if (problems.length) {
  log('问题：');
  for (const p of problems) log('  - ' + p);
  die('重排后不满足段窗约束', 1);
}

// 【顶层汇总必须一起算】只改 seg/totalFrames 而不改 maxRatio* 会得到
// 一个“总计说 0.947、逐句最大只有 0.627”的文件 —— 同一个量两种含义，
// 而下游（verify-voice-v11.mjs）正好会拿它当自述去对账。实测就是这么错了一次。
const longest = out.reduce((a, b) => (b.durSec > a.durSec ? b : a), out[0]);
const tightest = out.reduce((a, b) => (b.ratioAvail > a.ratioAvail ? b : a), out[0]);
const next = {
  ...doc,
  seg: SEG,
  xfade: XFADE,
  fps: FPS,
  beats: n,
  totalFrames: total,
  totalSec: +(total / FPS).toFixed(3),
  advanceSec: +advanceSec.toFixed(3),
  segSec: +segSec.toFixed(3),
  availSec: +availSec.toFixed(3),
  maxRatioAvail: +maxRatioAvail.toFixed(4),
  maxRatioSegment: +maxRatioSegment.toFixed(4),
  longestLine: { line: longest.line, text: longest.text, durSec: longest.durSec, beat: longest.beat },
  tightestLine: { line: tightest.line, text: tightest.text, ratioAvail: tightest.ratioAvail, beat: tightest.beat },
  lines: out,
};
// 兼容两种键名：老文件用 beats 存句子，这里保持 beats 为句子数组、详情另存
delete next.beats_detail;

if (DRY) { log('（--dry，不写盘）'); process.exit(0); }
fs.writeFileSync(TIMING, JSON.stringify(next, null, 1), 'utf8');
log(`已写 ${path.relative(VIDEO_DIR, TIMING)}`);
process.exit(0);
