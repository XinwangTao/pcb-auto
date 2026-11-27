#!/usr/bin/env node
/**
 * verify-voice-v11.mjs — 独立核对 V11 的配音/字幕时间轴。
 *
 * 为什么不读 timing.json 里的 durSec 就完事
 * -----------------------------------------
 * 「自述不是证据」：timing.json 是 tts_v11.py 写的，它说自己合格不等于合格。
 * 这里对**每一个交付音频重新 ffprobe 一次**，用实测时长算比值，再和 JSON 里的
 * 数字对一遍（差 > 1ms 就报不一致）。JSON 只用来拿「这句话是哪个字」与帧位置。
 *
 * 判据（任一条不过就退出码 1）
 * ---------------------------
 * 1. 8 句、每句文字 <= 14 字、文件存在
 * 2. 实测 durSec <= 段长 SEG/30（2.567s）        —— 题目要求的硬指标
 * 3. 实测 durSec <= 段推进 (SEG-XFADE)/30（2.233s）—— 更紧，防止撞下一句
 * 4. 帧级：startFrame + durFrames <= 下一段起点（末段 <= 总帧数）
 * 5. max(durSec / 段可用时长) <= 1.0 且与报告里的数字一致
 *
 * 用法：node scripts/verify-voice-v11.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VIDEO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIMING = path.join(VIDEO, 'public', 'voice_v11', 'timing.json');
const FFPROBE = process.env.FFPROBE || 'C:\\ffmpeg\\bin\\ffprobe.exe';
const FPS = 30;
// 【SEG 只能从 JSX 读】这个数字曾同时存在于 PcbRealV11.jsx / tts_v11.py /
// cut-motion.ps1 / 本文件四处。改 SEG 时漏了本文件 ⇒ 它拿 77 去判 110 的时间轴，
// 报出“第 5 句越过段界”这种**假红**，而真相是时间轴完好。
// 现在现读，并断言 timing.json 的 seg 与它一致。
import fsx from 'node:fs';
import pathx from 'node:path';
import urlx from 'node:url';
const HERE_X = pathx.dirname(urlx.fileURLToPath(import.meta.url));
const JSX_SRC = fsx.readFileSync(pathx.join(HERE_X, '..', 'src', 'PcbRealV11.jsx'), 'utf8');
const SEG = Number((JSX_SRC.match(/^const SEG = (\d+)/m) || [])[1]);
const XFADE = Number((JSX_SRC.match(/^const XFADE = (\d+)/m) || [])[1]);
if (!SEG || !XFADE) { console.log('  VOICE-V11=ENVSKIP  从 PcbRealV11.jsx 读不到 SEG/XFADE'); process.exit(2); }

const probe = (file) =>
  Number(
    execFileSync(
      FFPROBE,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { encoding: 'utf8' },
    ).trim(),
  );

const t = JSON.parse(fs.readFileSync(TIMING, 'utf8'));
const advance = SEG - XFADE;
const segSec = SEG / FPS;
const advanceSec = advance / FPS;
const availSec = Number((advanceSec - Number(t.leadSec)).toFixed(3));
const totalFrames = Number(t.totalFrames);

const problems = [];
let maxRatioAvail = 0;
let maxRatioSeg = 0;
let longest = { text: '', dur: 0 };
let tightest = { line: 0, ratio: 0, text: '' };

console.log(`timing.json: ${path.relative(VIDEO, TIMING)}`);
console.log(
  `段数 ${t.lines.length}  段长 ${segSec.toFixed(3)}s  推进 ${advanceSec.toFixed(3)}s  ` +
    `起播余量 ${t.leadSec}s  可用窗 ${availSec.toFixed(3)}s  总帧 ${totalFrames}\n`,
);
console.log(
  ' #  实测时长  JSON时长  JSON差   段长比  可用窗比  帧区间        ≤界   字  台词',
);

if (t.lines.length !== 8) problems.push(`句数 ${t.lines.length} ≠ 8`);
// 总帧数由 JSX 的 SEG/XFADE 现推，不写死
const expectTotal = (t.lines.length - 1) * (SEG - XFADE) + SEG;
if (totalFrames !== expectTotal) problems.push(`总帧 ${totalFrames} ≠ JSX 推出的 ${expectTotal}（SEG=${SEG} XFADE=${XFADE}）`);
if (Number(t.seg) !== SEG) problems.push(`timing.json 的 seg=${t.seg} 与 JSX 的 ${SEG} 不一致（两套账）`);

for (const l of t.lines) {
  const abs = path.join(VIDEO, 'public', l.file);
  if (!fs.existsSync(abs)) {
    problems.push(`第 ${l.line} 句缺文件：${l.file}`);
    continue;
  }
  const dur = probe(abs);
  const jsonDur = Number(l.durSec);
  const frameStart = l.startFrame;
  const frameEnd = frameStart + Math.max(1, Math.ceil(dur * FPS));
  const limit = l.line < t.lines.length ? l.line * advance : totalFrames;
  const rSeg = dur / segSec;
  const rAvail = dur / availSec;

  maxRatioAvail = Math.max(maxRatioAvail, rAvail);
  maxRatioSeg = Math.max(maxRatioSeg, rSeg);
  if (dur > longest.dur) longest = { text: l.text, dur };
  if (rAvail > tightest.ratio) tightest = { line: l.line, ratio: rAvail, text: l.text };

  if (Math.abs(dur - jsonDur) > 0.001) {
    problems.push(`第 ${l.line} 句实测 ${dur.toFixed(3)}s ≠ JSON ${jsonDur}s`);
  }
  if (rSeg > 1.0) problems.push(`第 ${l.line} 句 dur/段长 = ${rSeg.toFixed(3)} > 1.0`);
  if (rAvail > 1.0) problems.push(`第 ${l.line} 句 dur/可用窗 = ${rAvail.toFixed(3)} > 1.0`);
  if (frameEnd > limit) problems.push(`第 ${l.line} 句帧 ${frameEnd} 越过段界 ${limit}`);
  if ([...l.text].length > 14) problems.push(`第 ${l.line} 句 ${[...l.text].length} 字 > 14`);

  console.log(
    `${String(l.line).padStart(2)} ${dur.toFixed(3).padStart(8)} ${jsonDur
      .toFixed(3)
      .padStart(9)} ${(dur - jsonDur >= 0 ? '+' : '') + (dur - jsonDur).toFixed(3)
      .padStart(7)} ${rSeg.toFixed(3).padStart(7)} ${rAvail.toFixed(3).padStart(9)} ` +
      ` ${String(frameStart).padStart(4)}~${String(frameEnd).padEnd(4)} ${String(limit).padStart(4)}` +
      `  ${String([...l.text].length).padStart(2)}  ${l.text}`,
  );
}

console.log('');
console.log(
  `max(durSec/段长)      = ${maxRatioSeg.toFixed(4)}  （判据 <= 1.0）`,
);
console.log(
  `max(durSec/可用窗)    = ${maxRatioAvail.toFixed(4)}  （判据 <= 1.0，最紧一句 #${tightest.line}「${tightest.text}」）`,
);
console.log(
  `最长句                = 「${longest.text}」${longest.dur.toFixed(3)}s（段长 ${segSec.toFixed(3)}s，占 ${(
    (longest.dur / segSec) *
    100
  ).toFixed(1)}%）`,
);
console.log(
  `timing.json 自述      = maxRatioAvail ${t.maxRatioAvail} / maxRatioSegment ${t.maxRatioSegment}`,
);

if (Math.abs(Number(t.maxRatioAvail) - maxRatioAvail) > 0.002) {
  problems.push(
    `timing.json 自述 maxRatioAvail=${t.maxRatioAvail} 与实测 ${maxRatioAvail.toFixed(4)} 不一致`,
  );
}

if (problems.length) {
  console.log(`\n${problems.length} 条不通过：`);
  for (const p of problems) console.log('  ! ' + p);
  process.exit(1);
}
console.log('\n全部通过：8 句实测时长均 <= 段长与段推进，帧区间不越界');
