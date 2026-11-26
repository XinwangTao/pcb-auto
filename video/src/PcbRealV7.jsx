/**
 * PcbRealV7 · 用「EDA 画布真实渲染帧」当主素材的竖屏版
 *
 * 与 V6（gdigrab 录桌面）的根本区别：素材不再依赖桌面重绘，而是流水线在 9 个里程碑
 * 调用 eda.dmt_EditorControl.getCurrentRenderedAreaImage() 让 EDA 自己渲染画布，
 * PNG 落盘到 out/frames/<HHmmss>/0000-<tag>.png …。所以这里不写死任何镜头表：
 *
 *   out/frames/<最新时间戳目录>/*.png  → 正片（按文件名排序，一帧一段）
 *   out/stills/*.png                   → 占位（这些是成片抽帧，没有真实帧时顶上）
 *   两者都没有                          → 一张 CSS 占位卡，照样能渲染不崩
 *
 * 素材发现、排序、tag→中文标题映射、硬链接到 public/v7/ 全在 v7/prepare.mjs，
 * 由 remotion.config.mjs 在打包前跑一次，产物是 public/v7/manifest.json，
 * 本文件直接 import，因此 durationInFrames 在打包期就已确定。
 *
 * 刻意不做：封面页 / 片头 logo / 片尾感谢页。第一帧就是第一个阶段。
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
import manifest from '../public/v7/manifest.json';
import { FONT } from './fonts.js';

const FPS = 30;
const XFADE_S = 0.35; // 帧间交叉淡入时长
const SEG_TARGET_S = 34; // 画面总时长预算：帧多了自动压缩单帧时长，避免总长失控
const SEG_MIN_S = 3.2;
const SEG_MAX_S = 4.5;

const W = 1080;
const H = 1920;
const PAD = 44; // 左右安全边
const PLATE_W = W - PAD * 2; // 992：画布框宽度，与标题/字幕同宽，左右对齐更整
const HERO_TOP = 396; // 画布可用竖向区间
const HERO_BOTTOM = 1440;

const XFADE = Math.max(2, Math.round(XFADE_S * FPS)); // 11 帧
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = (p) => {
  const t = clamp(p, 0, 1);
  return t * t * (3 - 2 * t);
};

const C = {
  bg: '#06080D',
  ink: '#F4F7FF',
  dim: '#8B98B8',
  accent: '#2ED3A0',
  amber: '#FFB347',
  line: 'rgba(140,180,255,0.16)',
};

/** 没有素材时的合成内容：仍是一段完整画面，不会崩、不会黑 */
const EMPTY = {
  file: null,
  tag: '',
  stage: 'none',
  label: '等待 EDA 渲染帧',
  sub: '流水线跑完后，这里换成 EDA 渲染帧',
  w: 1600,
  h: 900,
  crop: null,
  placeholder: true,
};

// manifest 有两种合法形状，必须都认：
//  1) { items: [...], source: ... }  —— prepare.mjs 生成的旧形状
//  2) [...]                          —— frames-to-v7.mjs 用真实录制帧生成的裸数组
// 只认 manifest.items 的写法，在拿到真实录制帧之后会静默退回 EMPTY 占位卡：
// 画面不崩、不黑，看起来"正常"，但整支片子退化成一张等待卡 —— 这种失败最难发现。
// 所以这里显式兼容两种形状，并把发现形状不一致这件事留在 LAYOUT 里可查。
const MANIFEST_ITEMS = Array.isArray(manifest)
  ? manifest
  : (Array.isArray(manifest.items) ? manifest.items : []);
const MANIFEST_SOURCE = Array.isArray(manifest) ? 'frames-to-v7' : (manifest.source || null);
const ITEMS = MANIFEST_ITEMS.length ? MANIFEST_ITEMS : [EMPTY];
const N = ITEMS.length;
const SEG = Math.round(clamp(SEG_TARGET_S / N, SEG_MIN_S, SEG_MAX_S) * FPS);
const STARTS = ITEMS.map((_, i) => i * (SEG - XFADE));
export const PCB_V7_TOTAL_FRAMES = (N - 1) * (SEG - XFADE) + SEG;
export const PCB_V7_LAYOUT = { N, SEG, XFADE, total: PCB_V7_TOTAL_FRAMES, source: MANIFEST_SOURCE, placeholder: ITEMS[0] === EMPTY };

const SOURCE = MANIFEST_SOURCE;
const sourceLabel = (item) =>
  SOURCE === 'none'
    ? '等待素材 · out/frames 与 out/stills 都为空'
    : item.placeholder
      ? '占位素材 · 成片抽帧，非 EDA 画布'
      : `EDA 画布 · ${item.tag}`;

const num = (v, n = 2) => String(v).padStart(n, '0');

/** 画布几何：按素材真实比例算框高，contain 不裁内容；Ken Burns 只在框内推近 */
const geometryOf = (item) => {
  const eh = item.crop ? Math.max(1, item.crop[1] - item.crop[0]) : item.h || 900;
  const ew = item.w || 1600;
  const aspect = ew / eh;
  const plateH = Math.round(clamp(PLATE_W / aspect, 320, HERO_BOTTOM - HERO_TOP - 20));
  const top = Math.round(HERO_TOP + (HERO_BOTTOM - HERO_TOP - plateH) / 2);
  return { plateH, top, aspect };
};

/** 环境层：同一张画面极度模糊铺满 9:16，避免上下留白变成死黑 */
const Ambient = ({ item }) => {
  if (!item.file) return <AbsoluteFill style={{ background: `radial-gradient(120% 80% at 50% 30%, #0C1420 0%, ${C.bg} 70%)` }} />;
  return (
    <AbsoluteFill style={{ backgroundColor: C.bg }}>
      <Img
        src={staticFile(item.file)}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          filter: 'blur(40px) saturate(1.3) brightness(0.68)',
          transform: 'scale(1.3)',
        }}
      />
    </AbsoluteFill>
  );
};

/** 画布框：真实帧按 contain 完整显示；占位抽帧先裁掉上下自带的标题/图例 */
const CanvasPlate = ({ item, index }) => {
  const f = useCurrentFrame();
  const { plateH, top } = geometryOf(item);
  const p = clamp(f / Math.max(1, SEG - 1), 0, 1);
  const e = ease(p);

  // Ken Burns：偶数段推近、奇数段缓出，方向交替，避免整片单调
  const zoomIn = index % 2 === 0;
  const scale = zoomIn ? 1 + 0.08 * e : 1.08 - 0.08 * e;
  const tx = (zoomIn ? -1 : 1) * (e - 0.5) * 24;
  const ty = (zoomIn ? 1 : -1) * (e - 0.5) * 16;

  const k = PLATE_W / (item.w || 1600);

  return (
    <div
      style={{
        position: 'absolute',
        left: (W - PLATE_W) / 2,
        top,
        width: PLATE_W,
        height: plateH,
        borderRadius: 16,
        overflow: 'hidden',
        border: `1px solid ${C.line}`,
        boxShadow: '0 34px 100px rgba(0,0,0,0.82), 0 0 0 1px rgba(255,255,255,0.04)',
        background: '#000',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          transform: `scale(${scale}) translate(${tx}px, ${ty}px)`,
          transformOrigin: '50% 50%',
        }}
      >
        {item.file ? (
          item.crop ? (
            <Img
              src={staticFile(item.file)}
              style={{
                position: 'absolute',
                left: 0,
                top: -item.crop[0] * k,
                width: '100%',
                display: 'block',
              }}
            />
          ) : (
            <Img
              src={staticFile(item.file)}
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
          )
        ) : (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 18,
              background:
                'repeating-linear-gradient(45deg, rgba(46,211,160,0.06) 0 18px, transparent 18px 36px)',
              color: C.dim,
              fontSize: 34,
              fontWeight: 700,
            }}
          >
            <div style={{ fontSize: 56 }}>◻</div>
            <div>暂无渲染帧</div>
          </div>
        )}
      </div>
      {/* 画布内侧微暗角，压住边缘杂色 */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          boxShadow: 'inset 0 0 70px rgba(0,0,0,0.55)',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
};

/** 顶部：步骤号 + 中文阶段标题 + 细进度条（累计按帧序号走） */
const Header = ({ item, index, local }) => {
  const cum = clamp((index + ease(local / Math.max(1, SEG - 1))) / N, 0, 1);
  return (
    <div style={{ position: 'absolute', top: 104, left: PAD, width: W - PAD * 2 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 10, height: 10, borderRadius: 2, background: C.accent }} />
          <div
            style={{
              fontFamily: FONT.mono,
              fontSize: 26,
              fontWeight: 700,
              letterSpacing: 2,
              color: C.accent,
            }}
          >
            STEP {num(index + 1)} / {num(N)}
          </div>
        </div>
        <div
          style={{
            padding: '7px 16px',
            borderRadius: 999,
            fontSize: 21,
            fontWeight: 700,
            letterSpacing: 1,
            color: item.placeholder ? C.amber : C.accent,
            background: item.placeholder ? 'rgba(255,179,71,0.12)' : 'rgba(46,211,160,0.12)',
            border: `1px solid ${item.placeholder ? 'rgba(255,179,71,0.45)' : 'rgba(46,211,160,0.45)'}`,
          }}
        >
          {item.placeholder ? '占位素材' : 'EDA 实时渲染帧'}
        </div>
      </div>

      <div
        style={{
          marginTop: 18,
          fontSize: 64,
          fontWeight: 800,
          lineHeight: 1.16,
          color: C.ink,
          letterSpacing: 1,
          textShadow: '0 4px 24px rgba(0,0,0,0.55)',
        }}
      >
        {item.label}
      </div>

      <div
        style={{
          marginTop: 24,
          height: 7,
          width: '100%',
          borderRadius: 999,
          background: 'rgba(255,255,255,0.10)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${cum * 100}%`,
            height: '100%',
            borderRadius: 999,
            background: `linear-gradient(90deg, ${C.accent}, #8CE9C6)`,
          }}
        />
      </div>
    </div>
  );
};

/** 底部：来源说明 + 白色半透明底字幕（安全区内，≥46px） */
const LowerThird = ({ item, index }) => (
  <div
    style={{
      position: 'absolute',
      left: PAD,
      width: W - PAD * 2,
      bottom: 168,
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
    }}
  >
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontFamily: FONT.mono,
        fontSize: 23,
        color: C.dim,
        letterSpacing: 1,
      }}
    >
      <div>{sourceLabel(item)}</div>
      <div>
        {num(index + 1)} / {num(N)}
      </div>
    </div>

    <div
      style={{
        backgroundColor: 'rgba(255,255,255,0.90)',
        borderRadius: 16,
        padding: '18px 28px',
        boxShadow: '0 18px 50px rgba(0,0,0,0.45)',
      }}
    >
      <div
        style={{
          fontFamily: FONT.sans,
          fontSize: 52,
          lineHeight: 1.34,
          fontWeight: 700,
          color: '#0A0F18',
          textAlign: 'center',
          wordBreak: 'break-word',
          overflowWrap: 'anywhere',
          display: '-webkit-box',
          WebkitBoxOrient: 'vertical',
          WebkitLineClamp: 2,
          overflow: 'hidden',
        }}
      >
        {item.sub}
      </div>
    </div>
  </div>
);

const Segment = ({ item, index }) => {
  const f = useCurrentFrame();

  // 画面层：入画 0.35s 淡入（下一段压在上一段上面，等于交叉淡入，不会变暗）
  // 第一段不从纯黑起（0 帧纯黑在播放器里像坏片），从 45% 亮度提上来
  const contentOpacity =
    index === 0
      ? interpolate(f, [0, 10], [0.45, 1], { extrapolateRight: 'clamp' })
      : interpolate(f, [0, XFADE], [0, 1], { extrapolateRight: 'clamp' });

  // 文字层：上一段在自己的尾帧先淡出（对应本段开头），本段等老字幕走了再淡入，
  // 避免两段中文标题/字幕在同一位置重影，也避免上一段卸载时文字硬跳。
  const uiIn =
    index === 0
      ? interpolate(f, [0, 10], [0, 1], { extrapolateRight: 'clamp' })
      : interpolate(f, [XFADE - 2, XFADE + 8], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
  const uiOut =
    index === N - 1
      ? 1
      : interpolate(f, [SEG - 5, SEG - 1], [1, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
  const uiOpacity = Math.min(uiIn, uiOut);
  const uiY = interpolate(uiIn, [0, 1], [14, 0]);

  return (
    <AbsoluteFill>
      {/* 画面层 + 自带的上下压暗带一起淡入淡出：
          压暗带放进这一层，交叉淡入时不会去压暗上一段还没走完的标题 */}
      <AbsoluteFill style={{ opacity: contentOpacity }}>
        <Ambient item={item} />
        <CanvasPlate item={item} index={index} />
        <AbsoluteFill
          style={{
            background:
              'linear-gradient(180deg, rgba(5,8,14,0.90) 0%, rgba(5,8,14,0.30) 26%, rgba(5,8,14,0) 44%, rgba(5,8,14,0) 66%, rgba(5,8,14,0.86) 96%)',
            pointerEvents: 'none',
          }}
        />
      </AbsoluteFill>

      <AbsoluteFill style={{ opacity: uiOpacity, transform: `translateY(${uiY}px)` }}>
        <Header item={item} index={index} local={f} />
        <LowerThird item={item} index={index} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const PcbRealV7 = () => (
  <AbsoluteFill style={{ backgroundColor: C.bg, fontFamily: FONT.sans }}>
    {/* 配音：v7 九句旁白，由 scripts/tts_v7.py 逐句合成、逐句 loudnorm 到 -16 LUFS，
        再用绝对 adelay 拼成与画面段对齐的单轨（合计 30.59s / 目标 30.97s）。
        与 V6 同一音色：zh-CN-YunxiNeural，rate +8%。
        volume 0.9（不是 1）：实测 volume=1 时成片真峰值 -0.8 dBFS，比 V6 已验证的
        -1.4 dBFS 更热，平台转码有削波风险。降 0.9dB 后真峰值回到 -1.7 dBFS 左右，
        整体响度只掉约 0.9dB，仍在 -17 LUFS 一档，人声清晰度无损。 */}
    <Audio src={staticFile('voice_v7.wav')} volume={0.9} />
    {/* BGM：与 V6《运气的形状》同一首、同一条手机外放 EQ 链、同一母带响度，
        volume 0.78 是 V6 实测出来的值（人声空档约 -22.4dB，规范 ≥-24；
        成片真峰值 -1.5 dBTP；调到 0.85 会顶到 -0.7dBTP，平台转码有削波风险）。 */}
    <Audio src={staticFile('bgm_pcb_v6.wav')} volume={0.78} />
    {ITEMS.map((item, i) => (
      <Sequence
        key={`${i}-${item.file || 'empty'}`}
        from={STARTS[i]}
        durationInFrames={SEG}
        name={`v7-${num(i)}-${item.tag || 'empty'}`}
      >
        <Segment item={item} index={i} />
      </Sequence>
    ))}
  </AbsoluteFill>
);
