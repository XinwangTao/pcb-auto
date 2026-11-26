import React from 'react';
import {
  AbsoluteFill,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { C } from './ui.jsx';
import { FONT } from './fonts.js';

/**
 * 真实录屏版：画面主体是 AI 通过 CLI 真实操作嘉立创EDA 的屏幕录像。
 * 素材来源 out/gui-v6.mp4（18–70s），已切成 6 段并归一化到 1280x800@30fps。
 * 这里只做竖屏排版 + 阶段标题 + 进度条，画面内容原样保留。
 */

// dur 为 ffprobe 实测秒数（fps=30）
export const REAL_CLIPS = [
  { id: '01_sch', file: '01_sch.mp4', dur: 12, tag: '① 原理图连线',
    sub: '器件落位 · 逐脚拉线 · 网络标签' },
  { id: '02_pcbimp', file: '02_pcbimp.mp4', dur: 7, tag: '② 同步到 PCB',
    sub: '原理图变更 → PCB 导入' },
  { id: '03_layout', file: '03_layout.mp4', dur: 10, tag: '③ 自动布局 + 铺铜',
    sub: '器件排布 · GND 双面覆铜' },
  { id: '04_pour', file: '04_pour.mp4', dur: 8, tag: '④ 自动布线',
    sub: '走线 · 过孔' },
  { id: '05_route', file: '05_route.mp4', dur: 6, tag: '⑤ 清间距',
    sub: 'DRC 修错 · 间距优化' },
  { id: '06_final', file: '06_final.mp4', dur: 6, tag: '⑥ 完成',
    sub: 'DRC 通过 · 导出制造文件' },
];

const FPS = 30;
const toFrames = (s) => Math.round(s * FPS);

export const CLIP_FRAMES = (() => {
  let acc = 0;
  return REAL_CLIPS.map((c) => {
    const frames = toFrames(c.dur);
    const r = { ...c, from: acc, frames };
    acc += frames;
    return r;
  });
})();

const TOTAL_CLIP_FRAMES = CLIP_FRAMES.reduce((a, c) => a + c.frames, 0);

const TopBar = ({ clip }) => (
  <div
    style={{
      position: 'absolute', top: 0, left: 0, right: 0, height: 210,
      padding: '54px 56px 0', display: 'flex', flexDirection: 'column', gap: 14,
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <div
        style={{
          width: 46, height: 46, borderRadius: 12,
          background: `linear-gradient(135deg, ${C.accent}, ${C.accent2})`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 26, fontWeight: 800, color: '#04121f',
        }}
      >
        AI
      </div>
      <div style={{ fontSize: 34, fontWeight: 800, color: C.ink, letterSpacing: 1 }}>
        AI 全自动设计 PCB
      </div>
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 6 }}>
      <div
        style={{
          padding: '8px 20px', borderRadius: 999,
          background: `${C.accent}22`, border: `1.5px solid ${C.accent}66`,
          color: C.accent, fontSize: 27, fontWeight: 700,
        }}
      >
        {clip.tag}
      </div>
      <div style={{ fontSize: 23, color: C.dim }}>{clip.sub}</div>
    </div>
  </div>
);

const BottomBar = ({ progress, label }) => (
  <div
    style={{
      position: 'absolute', bottom: 0, left: 0, right: 0, height: 170,
      padding: '0 56px 44px', display: 'flex', flexDirection: 'column',
      justifyContent: 'flex-end', gap: 18,
    }}
  >
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
      <div style={{ fontSize: 29, fontWeight: 700, color: C.ink }}>{label}</div>
      <div style={{ fontSize: 22, color: C.faint }}>真实操作录像 · 无人工干预</div>
    </div>
    <div style={{ height: 10, borderRadius: 999, background: 'rgba(255,255,255,0.10)', overflow: 'hidden' }}>
      <div
        style={{
          width: `${Math.max(0, Math.min(1, progress)) * 100}%`,
          height: '100%',
          background: `linear-gradient(90deg, ${C.accent}, ${C.green})`,
        }}
      />
    </div>
  </div>
);

const ClipScene = ({ clip, index }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = spring({ frame: f, fps, config: { damping: 200 }, durationInFrames: 12 });
  const scale = interpolate(enter, [0, 1], [0.97, 1]);
  const y = interpolate(enter, [0, 1], [28, 0]);
  const drift = interpolate(f, [0, clip.frames], [1.0, 1.03]);

  const progress = (clip.from + f) / TOTAL_CLIP_FRAMES;

  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <TopBar clip={clip} />

      {/* 录屏主视觉：源已裁成纯绘图区 1280x796（≈1.608:1），按同比例取 1000x622，
          不裁边也不变形，画面里只剩原理图/PCB 画布本身，细节最清楚 */}
      <div
        style={{
          position: 'absolute', top: 236, left: 40, width: 1000, height: 622,
          transform: `translateY(${y}px) scale(${scale * drift})`,
          borderRadius: 18, overflow: 'hidden',
          border: `1.5px solid ${C.accent}44`,
          boxShadow: '0 30px 90px rgba(0,0,0,0.75), 0 0 0 1px rgba(255,255,255,0.05)',
          background: '#000',
        }}
      >
        <OffthreadVideo
          src={staticFile(`real/${clip.file}`)}
          // 原理图段裁成 1280x796(1.608:1)、PCB 段裁成 1148x796(1.442:1)，
          // 比例不同 —— 用 cover 会把 PCB 的上下裁掉（丢掉板框边和坐标尺），
          // 所以用 contain：PCB 两侧留一点点黑边，但绝不切内容。
          style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
          muted
        />
        <div
          style={{
            position: 'absolute', top: 14, right: 16,
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '6px 14px', borderRadius: 999,
            background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.16)',
          }}
        >
          <div
            style={{
              width: 11, height: 11, borderRadius: '50%', background: '#ff4d4f',
              opacity: 0.55 + 0.45 * Math.abs(Math.sin((f / 12) * Math.PI)),
            }}
          />
          <div style={{ fontSize: 19, color: '#e8eefc', fontWeight: 600 }}>REC</div>
        </div>
      </div>

      {/* 指标行 */}
      <div style={{ position: 'absolute', top: 900, left: 40, width: 1000, display: 'flex', gap: 18 }}>
        {[
          { k: '设计', v: 'SHT30 温湿度 + LDO' },
          { k: '板框', v: '1200 × 900 mil' },
          { k: 'DRC', v: '0 违规' },
        ].map((m) => (
          <div
            key={m.k}
            style={{
              flex: 1, padding: '22px 24px', borderRadius: 14,
              background: 'rgba(255,255,255,0.045)', border: `1px solid ${C.line}`,
            }}
          >
            <div style={{ fontSize: 21, color: C.faint, marginBottom: 8 }}>{m.k}</div>
            <div style={{ fontSize: 27, color: C.ink, fontWeight: 700 }}>{m.v}</div>
          </div>
        ))}
      </div>

      {/* 全流程清单：当前步高亮，让人一眼看清"一步步" */}
      <div style={{ position: 'absolute', top: 1120, left: 44, width: 992 }}>
        {CLIP_FRAMES.map((c, i) => {
          const done = i < index;
          const active = i === index;
          return (
            <div
              key={c.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 18, padding: '13px 0',
                opacity: done ? 0.55 : active ? 1 : 0.34,
                borderBottom: '1px solid rgba(255,255,255,0.055)',
              }}
            >
              <div
                style={{
                  width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 18, fontWeight: 800,
                  background: done ? C.green : active ? C.accent : 'rgba(255,255,255,0.12)',
                  color: done || active ? '#04121f' : C.dim,
                }}
              >
                {done ? '✓' : i + 1}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 26, color: active ? C.ink : C.dim, fontWeight: active ? 700 : 500 }}>
                  {c.tag.replace(/^[①②③④⑤⑥]\s*/, '')}
                </div>
                {active ? (
                  <div style={{ fontSize: 20, color: C.accent, marginTop: 3 }}>{c.sub}</div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <BottomBar progress={progress} label={`第 ${index + 1} / ${CLIP_FRAMES.length} 步`} />
    </AbsoluteFill>
  );
};

export const PcbReal = () => (
  <AbsoluteFill style={{ background: C.bg, fontFamily: FONT.sans }}>
    {CLIP_FRAMES.map((clip, i) => (
      <Sequence key={clip.id} from={clip.from} durationInFrames={clip.frames} name={clip.id}>
        <ClipScene clip={clip} index={i} />
      </Sequence>
    ))}
  </AbsoluteFill>
);

export const REAL_TOTAL_FRAMES = TOTAL_CLIP_FRAMES;
