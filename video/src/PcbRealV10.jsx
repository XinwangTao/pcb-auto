/**
 * PcbRealV10 · 「AI 真的在驱动 EDA 软件画 PCB」
 *
 * 【和 V9 的差别是内容差别，不是外观】
 * V9 是 11 段跨批次的里程碑混剪。V10 换一条更硬的线索：**每一次尝试单独成段**，
 * 段内按拍摄序号连播 1–5 张画布帧 —— 让观众看见「画面自己在变」，而不是「一张好看的板」。
 * 16 段跨 5 个批次：140310(14:03) → 171654(17:16) → 175901(17:59) → 185013(18:50) → 192608(19:26，在建)。
 *
 * 【素材是什么，写死在这里免得又被说成"摆拍"】
 * 全部来自 `out/frames/<批次>/<尝试>/*.png` —— 流水线在里程碑调用
 * `eda.dmt_EditorControl.getCurrentRenderedAreaImage()` 让 EDA **自己渲染画布**并落盘的 PNG。
 * 没有任何 AI 生成的示意图，也没有一帧是合成出来的软件界面。
 *
 * 坑（V9 之后的实测，都写进 build-v10.mjs 的断言里了）：
 *   1) `0000-sch-wired.png` 是**空画布**（1000×410 / 13KB / 没有一块彩色的板）。
 *      4 个批次里这一张 sha256 完全相同。它顶上去就是一块白板，不报错。
 *   2) 140310/1-smart-fit 的 140 张 PNG 只有 38 张不同画面；175901 的
 *      route-t39s/t163s/t288s/t403s **四张字节完全相同**。按"进度"挑帧会挑到 4 张同一张图。
 *   所以帧列表由 build-v10.mjs 生成（含去重与断言），本文件只负责把它们排成时间线。
 *
 * 时间轴：段间 10 帧交叉淡入（下一段压在上一段上，不用黑场），段内**硬切**
 *   （每张都是不同的真实拍摄，淡入会假装出并不存在的中间帧）。
 * 每段前 6 帧 scale 1.045→1 推入；段内 Ken Burns 按帧序号交替 100%→104% / 104%→100%。
 * 刻意不做：封面页 / 片头 logo / 片尾感谢页。第一帧就是第一张真实画布帧。
 */
import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
} from 'remotion';
import manifest from '../public/v10/manifest.json';
import { FONT } from './fonts.js';

const FPS = 30;
const XFADE = 10; // 段间交叉淡入（帧）
const SEG = 77; // 每段时长（帧）→ 16 段 = 16*77-15*10 = 1082 帧 = 36.07s
const XFADE_S = XFADE / FPS;

const W = 1080;
const H = 1920;
const PAD = 44;
const PLATE_W = W - PAD * 2; // 992
const PLATE_H_MAX = 940;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = (p) => {
  const t = clamp(p, 0, 1);
  return t * t * (3 - 2 * t);
};

const C = {
  bg: '#06080D',
  ink: '#F4F7FF',
  dim: '#8B98B8',
  faint: '#5A6480',
  accent: '#2ED3A0',
  amber: '#FFB347',
  line: 'rgba(140,180,255,0.16)',
  plate: 'rgba(120,150,200,0.28)',
};

const BEATS = Array.isArray(manifest.beats) ? manifest.beats : [];
const SOURCE = manifest.source || {};
export const PCB_V10_TOTAL_FRAMES = BEATS.length ? (BEATS.length - 1) * (SEG - XFADE) + SEG : 90;
export const PCB_V10_LAYOUT = {
  beats: BEATS.length,
  frames: BEATS.reduce((n, b) => n + (b.frames ? b.frames.length : 0), 0),
  SEG,
  XFADE,
  total: PCB_V10_TOTAL_FRAMES,
  seconds: +(PCB_V10_TOTAL_FRAMES / FPS).toFixed(3),
  scannedPng: SOURCE.scannedPng ?? null,
  distinctImages: SOURCE.distinctImages ?? null,
};

const pad2 = (n) => String(n).padStart(2, '0');

/** 背景：极暗底 + 细网格 + 顶部渐晕（不抢画面） */
const Backdrop = () => (
  <AbsoluteFill
    style={{
      backgroundColor: C.bg,
      backgroundImage:
        `radial-gradient(1200px 700px at 50% -10%, rgba(46,211,160,0.10), transparent 70%),` +
        `radial-gradient(900px 600px at 50% 110%, rgba(90,140,255,0.08), transparent 70%)`,
    }}
  >
    <AbsoluteFill
      style={{
        backgroundImage:
          'linear-gradient(to right, rgba(140,180,255,0.055) 1px, transparent 1px),' +
          'linear-gradient(to bottom, rgba(140,180,255,0.055) 1px, transparent 1px)',
        backgroundSize: '60px 60px',
        opacity: 0.55,
      }}
    />
  </AbsoluteFill>
);

/** 画布框：把源图的 crop 区域恰好铺满，contain 不裁内容，Ken Burns 只放大不露出边 */
const Plate = ({ item, shot, shotCount, localFrame, shotFrames }) => {
  const crop = item.crop || { x: 0, y: 0, w: item.srcW, h: item.srcH };
  const aspect = crop.w / crop.h;
  const plateW = Math.min(PLATE_W, PLATE_H_MAX * aspect);
  const plateH = plateW / aspect;
  const scale = plateW / crop.w;
  const srcW = item.srcW;
  const srcH = item.srcH;

  // 段入场推入：前 6 帧 1.045 → 1
  const push = interpolate(localFrame, [0, 6], [1.045, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  // 段内 Ken Burns：按**这一张帧**在段内走了多少帧算，交替 100%→104% / 104%→100%
  const inShot = localFrame - shot * shotFrames;
  const kb = interpolate(inShot, [0, Math.max(1, shotFrames - 1)], shot % 2 === 0 ? [1.0, 1.04] : [1.04, 1.0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div
      style={{
        position: 'absolute',
        left: (W - plateW) / 2,
        top: 560 + (PLATE_H_MAX - plateH) / 2,
        width: plateW,
        height: plateH,
        borderRadius: 10,
        overflow: 'hidden',
        boxShadow: '0 30px 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(140,180,255,0.10)',
        background: '#03040a',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          transform: `scale(${push * kb})`,
          transformOrigin: 'center center',
        }}
      >
        <Img
          src={staticFile(item.frames[shot].file)}
          style={{
            position: 'absolute',
            left: -crop.x * scale,
            top: -crop.y * scale,
            width: srcW * scale,
            height: srcH * scale,
            imageRendering: 'auto',
          }}
        />
      </div>
      {/* 框线 + 四角刻线（真实画布感，不是装饰） */}
      <div style={{ position: 'absolute', inset: 0, border: `1px solid ${C.plate}` }} />
      {[
        [0, 0, 'left', 'top'],
        [1, 0, 'right', 'top'],
        [0, 1, 'left', 'bottom'],
        [1, 1, 'right', 'bottom'],
      ].map(([fx, fy], i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            width: 18,
            height: 18,
            [fx ? 'right' : 'left']: -1,
            [fy ? 'bottom' : 'top']: -1,
            borderTop: fy ? 'none' : `2px solid ${C.accent}`,
            borderBottom: fy ? `2px solid ${C.accent}` : 'none',
            borderLeft: fx ? 'none' : `2px solid ${C.accent}`,
            borderRight: fx ? `2px solid ${C.accent}` : 'none',
            opacity: 0.8,
          }}
        />
      ))}
      {/* 帧内标签：真实帧来源 + 第几帧 */}
      <div
        style={{
          position: 'absolute',
          left: 12,
          top: 10,
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          fontFamily: FONT.mono,
          fontSize: 20,
          letterSpacing: 1,
          // 竖长板的 crop 只有 183px 宽，不加 nowrap 会把「EDA 画布」折成两行
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{ flex: '0 0 auto', whiteSpace: 'nowrap', background: 'rgba(46,211,160,0.92)', color: '#02120c', padding: '3px 8px', borderRadius: 4, fontWeight: 700 }}>
          EDA 画布
        </span>
        <span style={{ flex: '0 0 auto', whiteSpace: 'nowrap', background: 'rgba(3,5,10,0.72)', color: C.ink, padding: '3px 8px', borderRadius: 4 }}>
          {item.batch}/{item.attempt} · {shot + 1}/{shotCount}
        </span>
      </div>
      <div
        style={{
          position: 'absolute',
          right: 12,
          bottom: 10,
          fontFamily: FONT.mono,
          fontSize: 18,
          color: 'rgba(230,240,255,0.72)',
          background: 'rgba(3,5,10,0.66)',
          padding: '2px 8px',
          borderRadius: 4,
        }}
      >
        {item.frames[shot].tag}
      </div>
    </div>
  );
};

const Segment = ({ item, index }) => {
  const frame = useCurrentFrame();
  const n = Math.max(1, item.frames.length);
  // 段内均分：每张帧占 SEG/n 帧，硬切
  const shot = Math.min(n - 1, Math.floor((frame * n) / SEG));
  const shotFrames = Math.ceil(SEG / n);

  const appear = interpolate(frame, [0, 6], [0, 1], { extrapolateRight: 'clamp' });
  const rise = 34 * (1 - ease(appear));

  const run = item.run || {};
  const fact = run.available
    ? `${run.design} · 板框 ${run.board}mil · ${run.drcPassed ? 'DRC 通过' : `DRC 未过 ${run.drcLeaf}/${run.drcTotal} 组`} · 错误 ${run.errors} · 不匹配 ${run.mismatches} · 导出 ${run.exportsOk}/6 · ${run.elapsedS}s`
    : `运行数据：${run.why || '未知'}`;

  return (
    <AbsoluteFill style={{ fontFamily: FONT.sans }}>
      {/* 顶部：序号 + 段身份 */}
      <div
        style={{
          position: 'absolute',
          left: PAD,
          right: PAD,
          top: 150,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          opacity: 0.35 + 0.65 * ease(appear),
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
          <span style={{ fontFamily: FONT.mono, fontSize: 30, color: C.accent, fontWeight: 700 }}>{pad2(index + 1)}</span>
          <span style={{ fontFamily: FONT.mono, fontSize: 22, color: C.faint, letterSpacing: 2 }}>/ {pad2(BEATS.length)}</span>
        </div>
        <span style={{ fontFamily: FONT.mono, fontSize: 22, color: C.faint, letterSpacing: 1 }}>
          {item.batch} · {item.attempt}
        </span>
      </div>

      {/* 标题 */}
      <div
        style={{
          position: 'absolute',
          left: PAD,
          right: PAD,
          top: 356 + rise,
          fontSize: 68,
          lineHeight: 1.12,
          fontWeight: 700,
          color: C.ink,
          letterSpacing: 1,
          opacity: 0.35 + 0.65 * ease(appear),
          textShadow: '0 6px 30px rgba(0,0,0,0.5)',
        }}
      >
        {item.title}
      </div>

      {/* 副标题 */}
      <div
        style={{
          position: 'absolute',
          left: PAD,
          right: PAD,
          top: 452 + rise * 0.6,
          fontSize: 40,
          lineHeight: 1.3,
          color: C.amber,
          opacity: 0.35 + 0.65 * ease(appear),
        }}
      >
        {item.sub}
      </div>

      <Plate item={item} shot={shot} shotCount={n} localFrame={frame} shotFrames={shotFrames} />

      {/* 数字事实（全部现读 _run-*.json，不手写） */}
      <div
        style={{
          position: 'absolute',
          left: PAD,
          right: PAD,
          top: 1536,
          fontFamily: FONT.mono,
          fontSize: 25,
          lineHeight: 1.5,
          color: C.dim,
          opacity: 0.4 + 0.6 * ease(appear),
        }}
      >
        {fact}
      </div>

      {/* 帧来源（可回溯到 out/frames 里那一张） */}
      <div
        style={{
          position: 'absolute',
          left: PAD,
          right: PAD,
          top: 1610,
          fontFamily: FONT.mono,
          fontSize: 21,
          lineHeight: 1.45,
          color: C.faint,
        }}
      >
        <span style={{ color: C.accent }}>帧来源 </span>
        out/frames/{item.frames[shot].src}
      </div>

      {/* 段内进度：n 个点，当前帧高亮 —— 让"这是第几张"看得见 */}
      <div
        style={{
          position: 'absolute',
          left: PAD,
          right: PAD,
          top: 1676,
          display: 'flex',
          gap: 8,
          alignItems: 'center',
        }}
      >
        {item.frames.map((f, i) => (
          <div
            key={f.file}
            style={{
              flex: 1,
              height: 6,
              borderRadius: 3,
              background: i <= shot ? C.accent : 'rgba(140,180,255,0.16)',
              opacity: i === shot ? 1 : 0.55,
            }}
          />
        ))}
      </div>
    </AbsoluteFill>
  );
};

/** 交叉淡入：下一段的头 XFADE 帧压在上一段上；段本身全不透明（硬切） */
const XFade = ({ item, index, from }) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [0, XFADE], [0, 1], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ opacity: o }}>
      <Segment item={item} index={index} />
    </AbsoluteFill>
  );
};

const ProgressBar = () => {
  const frame = useCurrentFrame();
  const p = clamp(frame / Math.max(1, PCB_V10_TOTAL_FRAMES - 1), 0, 1);
  return (
    <>
      <div style={{ position: 'absolute', left: PAD, right: PAD, bottom: 196, height: 4, background: 'rgba(140,180,255,0.14)', borderRadius: 2 }}>
        <div style={{ width: `${p * 100}%`, height: '100%', background: C.accent, borderRadius: 2 }} />
      </div>
      <div
        style={{
          position: 'absolute',
          left: PAD,
          right: PAD,
          bottom: 150,
          display: 'flex',
          justifyContent: 'space-between',
          fontFamily: FONT.mono,
          fontSize: 20,
          color: C.faint,
          letterSpacing: 1,
        }}
      >
        <span>AI 真的在驱动 EDA 软件画 PCB</span>
        <span>
          {(frame / FPS).toFixed(1)}s / {(PCB_V10_TOTAL_FRAMES / FPS).toFixed(1)}s
        </span>
      </div>
    </>
  );
};

export const PcbRealV10 = () => {
  const starts = BEATS.map((_, i) => i * (SEG - XFADE));
  if (!BEATS.length) {
    return (
      <AbsoluteFill style={{ backgroundColor: C.bg, color: C.ink, fontFamily: FONT.sans, padding: 80 }}>
        <div style={{ fontSize: 60, fontWeight: 700 }}>没有素材</div>
        <div style={{ fontSize: 34, color: C.dim, marginTop: 24 }}>
          public/v10/manifest.json 的 beats 为空。先跑 video/scripts/build-v10.mjs。
        </div>
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{ backgroundColor: C.bg, fontFamily: FONT.sans }}>
      {/* BGM：36.0667s，由 video/mix-and-ship.ps1 的配方现场生成（highpass 70 → 3 段 EQ →
          afade 1.5s in / 2.5s out 锚在片尾 → loudnorm -19 LUFS → volume 0.78）。
          **没有配音**：voice_v9.wav 是给 V9 的 31.533s 时间轴录的，段数与内容都跟 V10 不同，
          套上来会音画错位，所以这里只挂 BGM，不拿别的配音凑数。 */}
      <Audio src={staticFile('v10/bgm.wav')} volume={1} />
      <Backdrop />
      {BEATS.map((item, i) => (
        <Sequence
          key={item.id}
          from={starts[i]}
          durationInFrames={i === 0 ? SEG : SEG}
          name={`v10-${pad2(i + 1)}-${item.id}`}
        >
          {i === 0 ? <Segment item={item} index={i} /> : <XFade item={item} index={i} from={starts[i]} />}
        </Sequence>
      ))}
      <ProgressBar />
    </AbsoluteFill>
  );
};

export const V10_META = { XFADE_S, SEG, FPS };
