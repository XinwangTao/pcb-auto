/**
 * Subtitle · V11 竖屏硬字幕（一行，压在画面下三分之一，带描边 + 半透明底）
 *
 * 为什么要做成组件 + 常量导出
 * ---------------------------
 * 字幕的位置/字号是**排版合约**：它必须落在画布框下沿（y=1322）与「数字事实」行
 * （y=1536）之间的空白带里，宽 1080 的画面上还要保证 13 个汉字一行不折行。
 * 这些数字写死在 JSX 里，验收时就没法用脚本核对「字幕有没有飘到别处」。
 * 所以集中放到 SUBTITLE_LAYOUT，由报告和核对脚本直接读（见 out/_probe/VOICE-SUBS.md）。
 *
 * 为什么不用 CSS 动画
 * ------------------
 * Remotion 是**逐帧截图**渲染的：CSS transition/keyframes 在截到的那一帧上取值不确定，
 * 同一帧两次渲染可能不一样，还会让 --concurrency 下的多 page 结果不一致。
 * 所以进出场一律 interpolate 按帧算（与 PcbRealV11 的 Segment 入场同一套写法）。
 *
 * 为什么字幕区间跟配音区间绑死
 * ---------------------------
 * 声音什么时候出来，字幕就什么时候出现，声音结束就撤 —— 参数直接来自
 * public/voice_v11/timing.json（startFrame / durFrames）。口播与字幕分开定时，
 * 一定会出现「字在念下一句」的漂移。
 */
import React from 'react';
import { interpolate } from 'remotion';
import { FONT } from './fonts.js';

const W = 1080;

/** 排版合约：报告与核对脚本读这里，别在 JSX 里另写一份 */
export const SUBTITLE_LAYOUT = {
  /** 字幕带顶边（画布框下沿 1322，数字事实行 1536，正好居中偏上） */
  top: 1356,
  height: 132,
  /** 底宽：与 PAD=44 的版心同宽 */
  width: W - 44 * 2, // 992
  fontSize: 62,
  fontWeight: 800,
  lineHeight: 1.25,
  /** 左右内边距（文字实际可用宽度 = 992-88 = 904px，13 个汉字 @62px = 806px） */
  paddingX: 44,
  /** 暗底最大不透明度（半透明底） */
  scrimAlpha: 0.88,
  /** 描边宽度（用 8 向 text-shadow 模拟，Chromium 对中文多边形描边更干净） */
  strokePx: 3,
  color: '#FFFFFF',
  accent: '#2ED3A0',
  /** 进出场帧数 */
  inFrames: 4,
  outFrames: 5,
  /** 入场位移（px），按 interpolate 上升 */
  risePx: 14,
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = (p) => {
  const t = clamp(p, 0, 1);
  return t * t * (3 - 2 * t);
};

const L = SUBTITLE_LAYOUT;

const stroke = [
  `-${L.strokePx}px 0 0 rgba(0,0,0,0.78)`,
  `${L.strokePx}px 0 0 rgba(0,0,0,0.78)`,
  `0 -${L.strokePx}px 0 rgba(0,0,0,0.78)`,
  `0 ${L.strokePx}px 0 rgba(0,0,0,0.78)`,
  '-2px -2px 0 rgba(0,0,0,0.78)',
  '2px -2px 0 rgba(0,0,0,0.78)',
  '-2px 2px 0 rgba(0,0,0,0.78)',
  '2px 2px 0 rgba(0,0,0,0.78)',
  '0 10px 30px rgba(0,0,0,0.92)',
].join(', ');

/** 数字（实测数据）用主题绿，让「28 / 115 / 410 / 6」一眼能抓住 */
const withNumbers = (text) =>
  String(text)
    .split(/(\d+)/)
    .filter((s) => s.length > 0)
    .map((s, i) =>
      /^\d+$/.test(s) ? (
        <span key={i} style={{ color: L.accent }}>{s}</span>
      ) : (
        <span key={i}>{s}</span>
      ),
    );

/**
 * @param {string} text        这一句的字（来自 timing.json）
 * @param {number} localFrame  useCurrentFrame()（段内局部帧）
 * @param {number} startFrame  这句配音在本段内的起始帧
 * @param {number} durFrames   这句配音占的帧数
 */
export const Subtitle = ({ text, localFrame, startFrame, durFrames }) => {
  if (!text) return null;
  const endFrame = startFrame + durFrames;

  // 进：声音出来前 2 帧就开始浮上来（字幕要「先到」一点，读起来才不追）
  const inP = ease(clamp((localFrame - (startFrame - 2)) / L.inFrames, 0, 1));
  // 出：声音结束后再留 outFrames 帧给人看完最后一个字
  const outP = 1 - ease(clamp((localFrame - endFrame) / L.outFrames, 0, 1));
  const opacity = clamp(inP * outP, 0, 1);
  if (opacity <= 0) return null;

  const dy = L.risePx * (1 - inP);
  const a = Math.round(L.scrimAlpha * opacity * 255) / 255;

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: L.top,
        height: L.height,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // 半透明底：中间实、两端虚，像压了一层渐变，不是贴了个盒子
        background:
          `linear-gradient(180deg, rgba(3,5,10,0) 0%, rgba(3,5,10,${a}) 24%,` +
          ` rgba(3,5,10,${a}) 76%, rgba(3,5,10,0) 100%)`,
        opacity,
      }}
    >
      <div
        style={{
          fontFamily: FONT.sans,
          fontSize: L.fontSize,
          fontWeight: L.fontWeight,
          lineHeight: L.lineHeight,
          color: L.color,
          letterSpacing: 1,
          paddingLeft: L.paddingX,
          paddingRight: L.paddingX,
          textAlign: 'center',
          // 竖屏字幕必须一行：折行会顶到「数字事实」那行
          whiteSpace: 'nowrap',
          textShadow: stroke,
          transform: `translateY(${dy.toFixed(2)}px)`,
        }}
      >
        {withNumbers(text)}
      </div>
    </div>
  );
};
