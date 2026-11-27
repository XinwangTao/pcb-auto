/**
 * PcbRealV11 · 「AI 真的在驱动 EDA 软件画 PCB」—— 单次建筑版
 *
 * 和 V10 的区别：V10 是跨 5 个批次的混剪（含失败尝试），
 * 用来讲「它试了好几次」。V11 只用**最近一次建筑**的帧：
 * 一次 attempt、一条时间线、从空白到可下单。
 *
 * 素材全部来自 `out/frames/<批次>/<尝试>/*.png` —— 流水线在里程碑调用
 * `eda.dmt_EditorControl.getCurrentRenderedAreaImage()` 让 EDA **自己渲染画布**并落盘。
 * 没有一帧是合成的软件界面；时间线由 video/scripts/build-v11.mjs 生成，
 * 它按 **tag 后缀**在当前批次里找帧（不写死批次号），并对空画布、
 * 字节重复做硬断言。
 *
 * 一致性：段间 10 帧交叉淡入，段内**硬切**（每张都是不同的真实拍摄，
 * 淡入会假装出并不存在的中间帧）。不做封面页 / 片头 logo / 片尾感谢页。
 *
 * V11 补上了配音与硬字幕（V10 没有）
 * ---------------------------------
 * 8 段 = 8 句中文口播，声音来自 public/voice_v11/s01..s08.wav（zh-CN-YunxiNeural，
 * +8%，-16 LUFS，由 scripts/tts_v11.py 生成），字幕就是这句的原文 —— 念什么、屏上
 * 写什么、什么时候出现，三者同源（timing.json + 本文件的 SEG/XFADE 几何）。
 *
 * 【时间轴只有一份几何】帧位置不读 timing.json 里的 startFrame，一律用本文件的
 *   voiceStart(i) = i*(SEG-XFADE) + VOICE_LEAD_FRAMES 现算：
 * tts 脚本那边给的是同一个公式（它会断言 startFrame 对得上），但 JSX 若直接信任
 * JSON，一旦有人只重跑 TTS 不改 SEG，声音就会整体偏移而画面看不出来。反过来，
 * 由本文件现算则：改了 SEG/XFADE，配音自动跟着段的起点走。
 *
 * 【每句必须短到装得下】段推进 67 帧 = 2.233s，扣除 2 帧起播余量后每句只有
 * 2.133s 的档位。超了 tts_v11.py 会以退出码 1 拒绝交付，而不是偷偷把音频加速 ——
 * 想加内容只能改短台词。
 */
import React from 'react';
import {
  AbsoluteFill,
  Audio,
  OffthreadVideo,
  Img,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
} from 'remotion';
import manifest from '../public/v11/manifest.json';
import timing from '../public/voice_v11/timing.json';
import { FONT } from './fonts.js';
import { Subtitle, SUBTITLE_LAYOUT } from './Subtitle.jsx';

const FPS = 30;
const XFADE = 10; // 段间交叉淡入（帧）
// 【每段时长】用户要求2026-11-27：77 帧（2.57s）字幕与配音呼吸不过来，
// 拉到 110 帧 = 3.667s。总帧数 = 7*100 + 110 = 810 = 27.0s。
// 改这个数字必须同步：tts_v11.py 的 SEG、它对总帧数的断言、
// cut-motion.ps1 的 -SegFrames（否则片段比段短，段尾会冻在最后一帧）。
// 每段时长（帧）。8 段 ⇒ 7*100 + 110 = 810 帧 = 27.00s
const SEG = 110;
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
export const PCB_V11_TOTAL_FRAMES = BEATS.length ? (BEATS.length - 1) * (SEG - XFADE) + SEG : 90;
export const PCB_V11_LAYOUT = {
  beats: BEATS.length,
  frames: BEATS.reduce((n, b) => n + (b.frames ? b.frames.length : 0), 0),
  SEG,
  XFADE,
  total: PCB_V11_TOTAL_FRAMES,
  seconds: +(PCB_V11_TOTAL_FRAMES / FPS).toFixed(3),
  scannedPng: SOURCE.scannedPng ?? null,
  distinctImages: SOURCE.distinctImages ?? null,
};

const pad2 = (n) => String(n).padStart(2, '0');

// ── 配音 / 字幕真源 ───────────────────────────────────────────────────────
// 只从 timing.json 取两样东西：这一句是什么字（text）、它有多长（durSec）。
// 帧位置一律现算（见文件头「时间轴只有一份几何」）。
const VOICE_LINES = Array.isArray(timing && timing.lines) ? timing.lines : [];
const VOICE_LEAD_FRAMES = Math.round((Number(timing && timing.leadSec) || 0.08) * FPS);
const VOICE_BY_BEAT = new Map(VOICE_LINES.map((l) => [String(l.beat), l]));

/** 这句配音从本段第几帧开始（段内局部帧；跨段起点由 Sequence 的 from 提供） */
const voiceStartAbs = (beatIndex) => beatIndex * (SEG - XFADE) + VOICE_LEAD_FRAMES;

/** 这句配音占多少帧（与 tts_v11.py 的 ceil(durSec*30) 同一算法） */
const voiceFrames = (line) => Math.max(1, Math.ceil(Number(line.durSec) * FPS));

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
  // 【固定竖直区间】自动缩放后画面可能是**竖长**的（板子本身 222×624），
  // 而字幕带在 top:1356。若按旧算法把高度撑到 940，画框底边会到 1500，
  // 字幕就直接压在图像上。所以把画框限在一个**固定区间**里居中：
  // 上边 560 / 下边 1340（=1356 字幕带之上），高度 780。横屏、竖屏都不会越界。
  const PLATE_BAND_TOP = 560;
  const PLATE_BAND_H = 780;
  const plateW = Math.min(PLATE_W, PLATE_BAND_H * aspect);
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
    <>
      {/*
        【模糊铺底】竖长画框两侧原来是大片死黑。短视频常见做法：把**同一画面**
        放大、模糊、压暗铺满，再叠清晰画框。主体不被抢，两侧也不再是死黑。
        只在 aspect < 1（竖长）时铺：横屏画框几乎占满宽度，铺了也看不见。
        遮罩用 maskImage 上下渐隐，否则会在 520/1400 处留下一道硬边。
      */}
      {aspect < 1 && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            width: W,
            top: PLATE_BAND_TOP - 60,
            height: PLATE_BAND_H + 60,
            overflow: 'hidden',
            filter: 'blur(46px) saturate(1.2) brightness(0.42)',
            opacity: 0.62,
            maskImage: 'linear-gradient(to bottom, transparent 0%, #000 12%, #000 84%, transparent 100%)',
            WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, #000 12%, #000 84%, transparent 100%)',
          }}
        >
          {item.video ? (
            <OffthreadVideo
              src={staticFile(item.video.file)}
              muted
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            <Img
              src={staticFile(item.frames[shot].file)}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          )}
        </div>
      )}
    <div
      style={{
        position: 'absolute',
        left: (W - plateW) / 2,
        top: PLATE_BAND_TOP + (PLATE_BAND_H - plateH) / 2,
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
        {item.video ? (
          // 【真实运动画面】倍速已经在 ffmpeg 里 setpts 焕进文件，所以这里 playbackRate 恒为 1。
          // 屏幕上写的倍数与文件实长严格自洽，不是“数字一套账、画面另一套”；muted 是必须的（片段本身已 -an）。
          <OffthreadVideo
            src={staticFile(item.video.file)}
            muted
            style={{
              position: 'absolute',
              left: -crop.x * scale,
              top: -crop.y * scale,
              width: srcW * scale,
              height: srcH * scale,
              objectFit: 'cover',
            }}
          />
        ) : (
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
        )}
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
        {item.video
          ? `${item.video.speed}×`
          : item.frames[shot].tag}
      </div>
    </div>
    </>
  );
};

const Segment = ({ item, index, voice }) => {
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
        {item.video
          ? `${item.video.srcFile} 第 ${item.video.srcStart}s 起 ${item.video.srcWindowSec}s，${item.video.speed}× 加速 → ${item.video.outDurSec}s`
          : `out/frames/${item.frames[shot].src}`}
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

      {/* 硬字幕：位置在画布框（下沿 1322）与「数字事实」行（1536）之间的空白带，
          进出场与这句配音同起同落（见 Subtitle.jsx 的 SUBTITLE_LAYOUT） */}
      {voice ? (
        <Subtitle
          text={voice.text}
          localFrame={frame}
          startFrame={VOICE_LEAD_FRAMES}
          durFrames={voiceFrames(voice)}
        />
      ) : null}
    </AbsoluteFill>
  );
};

/** 交叉淡入：下一段的头 XFADE 帧压在上一段上；段本身全不透明（硬切） */
const XFade = ({ item, index, from, voice }) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [0, XFADE], [0, 1], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ opacity: o }}>
      <Segment item={item} index={index} voice={voice} />
    </AbsoluteFill>
  );
};

const ProgressBar = () => {
  const frame = useCurrentFrame();
  const p = clamp(frame / Math.max(1, PCB_V11_TOTAL_FRAMES - 1), 0, 1);
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
          {(frame / FPS).toFixed(1)}s / {(PCB_V11_TOTAL_FRAMES / FPS).toFixed(1)}s
        </span>
      </div>
    </>
  );
};

export const PcbRealV11 = () => {
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
          V11 起**下面叠了 8 句口播**（每句 -16 LUFS），BGM 若还按 1.0 放，人声会被垫住：
          这里压到 0.5（约 -6dB），只当底噪。配音与字幕都是本轮新录的，
          不再有 V10 那种「voice_v9 是别的段数，套上来会错位」的问题。 */}
      <Audio src={staticFile('v10/bgm.wav')} volume={0.5} />

      {/* 8 句配音：一句一段，起点 = 段起点 + 2 帧余量（voiceStartAbs 与字幕共用）。
          按 beat id 反查段序，所以 manifest 段序变了也不会串行。 */}
      {VOICE_LINES.map((line) => {
        const beatIndex = BEATS.findIndex((b) => b.id === line.beat);
        if (beatIndex < 0) return null; // manifest 里没有这一段：宁可不播，也不放错位置
        return (
          <Sequence
            key={`voice-${line.line}`}
            from={voiceStartAbs(beatIndex)}
            durationInFrames={voiceFrames(line)}
            name={`voice-${pad2(line.line)}-${line.beat}`}
          >
            <Audio src={staticFile(line.file)} volume={1} />
          </Sequence>
        );
      })}

      <Backdrop />
      {BEATS.map((item, i) => (
        <Sequence
          key={item.id}
          from={starts[i]}
          durationInFrames={i === 0 ? SEG : SEG}
          name={`v10-${pad2(i + 1)}-${item.id}`}
        >
          {i === 0 ? (
            <Segment item={item} index={i} voice={VOICE_BY_BEAT.get(String(item.id))} />
          ) : (
            <XFade item={item} index={i} from={starts[i]} voice={VOICE_BY_BEAT.get(String(item.id))} />
          )}
        </Sequence>
      ))}
      <ProgressBar />
    </AbsoluteFill>
  );
};

export const V10_META = { XFADE_S, SEG, FPS };

/** 配音/字幕的可核对摘要（报告与核对脚本读它，别去猜） */
export const PCB_V11_VOICE = {
  lines: VOICE_LINES.length,
  beats: BEATS.length,
  leadFrames: VOICE_LEAD_FRAMES,
  total: VOICE_LINES.reduce((n, l) => n + voiceFrames(l), 0),
  maxFrames: VOICE_LINES.reduce((n, l) => Math.max(n, voiceFrames(l)), 0),
  windowFrames: SEG - XFADE, // 每句必须装得下的档位
  subtitle: SUBTITLE_LAYOUT,
};
