/**
 * 「AI 全自动设计 PCB」宣传片 · 出品级版本
 *
 * 严格遵循 Obsidian《短视频出品标准》（基准作品 rust-seek-v6-bgm.mp4）：
 *   - 1080x1920 / 30fps / H.264
 *   - edge-tts 神经语音（zh-CN-YunxiNeural），-17.5 LUFS 实测
 *   - 字幕逐字高亮（karaoke），对齐靠 timeline_pcb.json 的真实语音区间
 *   - BGM 手机外放友好 EQ，比人声低约 3dB
 *   - 大字封面（竖版 + 横版）
 *
 * 与 rust-seek 版的区别：画面主体是**真实录屏**（AI 通过 CLI 操作嘉立创EDA），
 * 而不是产品截图。所以录屏框用 contain 完整显示，绝不裁内容。
 */
import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import timeline from './data/timeline_pcb.json';

const FPS = 30;
const LINES = timeline.lines;
const SCENES = timeline.scenes;
const TOTAL = timeline.total;
const TOTAL_FRAMES = Math.round(TOTAL * FPS);

// ── 配色（沿用 V6 定稿，只把主色从橙改为 PCB 绿松石，与 EDA 界面协调）──
const BG = '#07090F';
const PANEL = '#111722';
const ACCENT = '#2ED3A0';   // 主色：EDA 走线绿
const ACCENT2 = '#FFB347';  // 辅色：已读字幕高亮
const TEXT = '#F5F7FA';
const DIM = '#8792A6';
const HOT = '#FF6B35';      // 强调橙，用于「零违规」这类结论
const MONO = 'Consolas, "Courier New", monospace';
const SANS = '"Segoe UI", "Microsoft YaHei", sans-serif';

const at = (n) => Math.round(LINES[n - 1].start * FPS);

/** 场景区间转帧号（含 0.06s 提前量，让画面比声音略早出现，观感更自然） */
const sceneFrames = (name, lead = 0.06) => {
  const s = SCENES[name];
  return { from: Math.round((s.from - lead) * FPS), to: Math.round(s.to * FPS) };
};

// ─────────────── 通用视觉零件 ───────────────

const Backdrop = ({ hue = ACCENT }) => {
  const frame = useCurrentFrame();
  const glow = 0.5 + 0.5 * Math.sin(frame / 26);
  return (
    <AbsoluteFill style={{ backgroundColor: BG }}>
      <AbsoluteFill
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)',
          backgroundSize: '88px 88px',
          backgroundPosition: `0px ${(frame / FPS) * 18}px`,
          maskImage: 'radial-gradient(120% 78% at 50% 42%, black 24%, transparent 76%)',
          WebkitMaskImage: 'radial-gradient(120% 78% at 50% 42%, black 24%, transparent 76%)',
        }}
      />
      <AbsoluteFill
        style={{
          background: `radial-gradient(740px 740px at 50% 24%, ${hue}${glow > 0.5 ? '22' : '18'} 0%, transparent 70%)`,
        }}
      />
    </AbsoluteFill>
  );
};

const useEnter = (delay, damping = 14) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping } });
  return {
    opacity: interpolate(s, [0, 1], [0, 1]),
    transform: `translateY(${interpolate(s, [0, 1], [38, 0])}px)`,
  };
};

/** 缓慢推进，避免静止画面像 PPT */
const useCamera = (zoomFrom = 1.0, zoomTo = 1.055, driftY = -16) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const p = Math.min(1, Math.max(0, frame / Math.max(1, durationInFrames)));
  const e = p * p * (3 - 2 * p);
  return { scale: zoomFrom + (zoomTo - zoomFrom) * e, translateY: driftY * e };
};

const SceneTransition = ({ children, fadeIn = 8, fadeOut = 8 }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const inO = interpolate(frame, [0, fadeIn], [0, 1], { extrapolateRight: 'clamp' });
  const outO = interpolate(frame, [durationInFrames - fadeOut, durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
  });
  const opacity = Math.min(inO, outO);
  const scale = interpolate(frame, [0, fadeIn], [1.028, 1], { extrapolateRight: 'clamp' });
  return <AbsoluteFill style={{ opacity, transform: `scale(${scale})` }}>{children}</AbsoluteFill>;
};

/** 逐字高亮字幕：已读部分 ACCENT2，未读白色，底部 190px */
const Captions = ({ fontSize = 56 }) => {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const line = LINES.find((l) => t >= l.start - 0.12 && t <= l.end + 0.22);
  if (!line) return null;
  const local = Math.max(0, t - line.start);
  const shown = Math.min(
    line.text.length,
    Math.floor((local / Math.max(line.duration, 0.1)) * line.text.length),
  );
  const head = line.text.slice(0, shown);
  const tail = line.text.slice(shown);
  const enter = Math.min(1, local / 0.18);
  return (
    <div
      style={{
        position: 'absolute', left: 0, right: 0, bottom: 190,
        display: 'flex', justifyContent: 'center', padding: '0 60px',
        opacity: enter, transform: `translateY(${(1 - enter) * 12}px)`,
      }}
    >
      <div
        style={{
          fontFamily: SANS, fontSize, fontWeight: 800, lineHeight: 1.34, color: '#fff',
          textAlign: 'center', padding: '16px 30px', borderRadius: 18,
          backgroundColor: 'rgba(6,8,12,0.82)', border: '1px solid rgba(255,255,255,0.10)',
          textShadow: '0 2px 10px rgba(0,0,0,0.95)', boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
        }}
      >
        <span style={{ color: ACCENT2 }}>{head}</span>
        <span>{tail}</span>
      </div>
    </div>
  );
};

/** 顶部品牌条：始终在，强化「AI 在操作」 */
const TopBar = ({ step, total, label }) => (
  <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 200, padding: '54px 52px 0' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <div
        style={{
          width: 46, height: 46, borderRadius: 12,
          background: `linear-gradient(135deg, ${ACCENT}, #12C7FF)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 24, fontWeight: 800, color: '#04121f',
        }}
      >
        AI
      </div>
      <div style={{ fontSize: 33, fontWeight: 800, color: TEXT, letterSpacing: 1 }}>
        AI 全自动设计 PCB
      </div>
    </div>
    {step ? (
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 16 }}>
        <div
          style={{
            padding: '8px 20px', borderRadius: 999,
            background: `${ACCENT}20`, border: `1.5px solid ${ACCENT}66`,
            color: ACCENT, fontSize: 26, fontWeight: 700,
          }}
        >
          {step} / {total}
        </div>
        <div style={{ fontSize: 23, color: DIM }}>{label}</div>
      </div>
    ) : null}
  </div>
);

/** 真实录屏框：contain 完整显示，绝不裁内容。
 *  尺寸按 1080 宽重排：宽 1040（左边距 20），源 1122x796 比例 → 高约 740。 */
const ScreenBox = ({ file, top = 196, height = 738, zoomTo = 1.035 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 18 } });
  const z = interpolate(frame, [0, 110], [1.0, zoomTo]);
  return (
    <div
      style={{
        position: 'absolute', top, left: 20, width: 1040, height,
        opacity: interpolate(s, [0, 1], [0, 1]),
        transform: `translateY(${interpolate(s, [0, 1], [46, 0])}px) scale(${z})`,
        borderRadius: 16, overflow: 'hidden',
        border: `1.5px solid ${ACCENT}44`,
        boxShadow: '0 26px 80px rgba(0,0,0,0.78), 0 0 0 1px rgba(255,255,255,0.05)',
        background: '#000',
      }}
    >
      <OffthreadVideo
        src={staticFile(`real/${file}`)}
        style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
        muted
      />
      <div
        style={{
          position: 'absolute', top: 12, right: 14, display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 14px', borderRadius: 999,
          background: 'rgba(0,0,0,0.62)', border: '1px solid rgba(255,255,255,0.16)',
        }}
      >
        <div
          style={{
            width: 11, height: 11, borderRadius: '50%', background: '#ff4d4f',
            opacity: 0.55 + 0.45 * Math.abs(Math.sin((frame / 12) * Math.PI)),
          }}
        />
        <div style={{ fontSize: 19, color: '#e8eefc', fontWeight: 600 }}>REC 真实录屏</div>
      </div>
    </div>
  );
};

/** 步骤追踪：竖向 5 步，当前高亮 —— 填满画面中段并强化「一步步」 */
const STEPS = [
  { n: 1, name: '原理图连线', sub: '器件选型 · 引脚接线' },
  { n: 2, name: '同步到 PCB', sub: '原理图变更自动导入' },
  { n: 3, name: '布局与铺铜', sub: '按电气关系排布' },
  { n: 4, name: '自动布线', sub: '信号 / 电源 / 过孔' },
  { n: 5, name: 'DRC 与出图', sub: '清间距 · 制造文件' },
];

const StepTracker = ({ active, top = 1046 }) => (
  <div style={{ position: 'absolute', top, left: 20, width: 1040 }}>
    {STEPS.map((s) => {
      const done = s.n < active;
      const cur = s.n === active;
      return (
        <div
          key={s.n}
          style={{
            display: 'flex', alignItems: 'center', gap: 18, padding: '15px 20px',
            marginBottom: 10, borderRadius: 12,
            backgroundColor: cur ? `${ACCENT}14` : 'rgba(255,255,255,0.028)',
            border: `1px solid ${cur ? ACCENT + '55' : 'rgba(255,255,255,0.06)'}`,
            opacity: done ? 0.5 : cur ? 1 : 0.34,
          }}
        >
          <div
            style={{
              width: 38, height: 38, borderRadius: 19, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 19, fontWeight: 800,
              background: done ? ACCENT : cur ? ACCENT : 'rgba(255,255,255,0.12)',
              color: done || cur ? '#04121f' : DIM,
            }}
          >
            {done ? '✓' : s.n}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: SANS, fontSize: 27, fontWeight: cur ? 800 : 600, color: cur ? TEXT : DIM }}>
              {s.name}
            </div>
          </div>
          <div style={{ fontFamily: MONO, fontSize: 20, color: cur ? ACCENT : 'transparent' }}>{s.sub}</div>
        </div>
      );
    })}
  </div>
);

/** 底部进度条：把「一步步」可视化 */
const ProgressBar = ({ progress, caption }) => (
  <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 130, padding: '0 52px 46px' }}>
    <div style={{ fontSize: 22, color: DIM, marginBottom: 12 }}>{caption}</div>
    <div style={{ height: 9, borderRadius: 999, background: 'rgba(255,255,255,0.10)', overflow: 'hidden' }}>
      <div
        style={{
          width: `${Math.max(0, Math.min(1, progress)) * 100}%`, height: '100%',
          background: `linear-gradient(90deg, ${ACCENT}, #12C7FF)`,
        }}
      />
    </div>
  </div>
);

const SceneShell = ({ children, progress, caption, step, total, label }) => (
  <AbsoluteFill style={{ backgroundColor: BG, fontFamily: SANS }}>
    <Backdrop />
    <TopBar step={step} total={total} label={label} />
    {children}
    <ProgressBar progress={progress} caption={caption} />
  </AbsoluteFill>
);

// ─────────────── 各场景 ───────────────

/** 标题卡：一句话需求 → 一块真板子 */
const SceneTitle = () => {
  const a = useEnter(3);
  const b = useEnter(58);
  const cam = useCamera(1.0, 1.05, -14);
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', transform: `scale(${cam.scale})` }}>
      <div style={{ ...a, textAlign: 'center' }}>
        <div style={{ fontFamily: MONO, fontSize: 30, color: ACCENT, letterSpacing: 8, marginBottom: 30 }}>
          2026 · 全自动
        </div>
        <div style={{ fontFamily: SANS, fontSize: 92, fontWeight: 800, color: TEXT, lineHeight: 1.22 }}>
          一句话
        </div>
        <div style={{ fontFamily: SANS, fontSize: 76, fontWeight: 800, color: ACCENT, lineHeight: 1.32, marginTop: 6 }}>
          到一块真板子
        </div>
      </div>
      <div style={{ ...b, marginTop: 60, display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ width: interpolate(frame, [58, 88], [0, 96], { extrapolateRight: 'clamp' }), height: 3, background: ACCENT2 }} />
        <div style={{ fontFamily: MONO, fontSize: 30, color: DIM }}>0 人工干预</div>
        <div style={{ width: interpolate(frame, [58, 88], [0, 96], { extrapolateRight: 'clamp' }), height: 3, background: ACCENT2 }} />
      </div>
    </AbsoluteFill>
  );
};

/** 痛点钩子：不是剪的，没点鼠标 */
const SceneHook = () => {
  const a = useEnter(3);
  const b = useEnter(34);
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', padding: '0 64px' }}>
      <div style={{ ...a, fontFamily: SANS, fontSize: 66, fontWeight: 800, color: TEXT, textAlign: 'center', lineHeight: 1.36 }}>
        这不是<span style={{ color: HOT }}>剪辑</span>出来的
      </div>
      <div
        style={{
          ...b, marginTop: 46, padding: '26px 38px', borderRadius: 22,
          backgroundColor: PANEL, border: `1px solid ${HOT}55`, textAlign: 'center',
        }}
      >
        <div style={{ fontFamily: SANS, fontSize: 52, fontWeight: 800, color: TEXT, lineHeight: 1.4 }}>
          没有一个鼠标
          <br />
          是我点的
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** 录屏场景统一骨架：录屏 + 指标条 + 结论条 + 步骤追踪 */
const ScreenScene = ({ file, step, label, caption, metrics, note, noteHot }) => {
  const frame = useCurrentFrame();
  // 指标条从录屏下沿开始，结论条紧随，步骤追踪填空余
  const m0 = useEnter(18);
  const m1 = useEnter(28);
  const m2 = useEnter(38);
  const noteSt = useEnter(52);
  const ms = [m0, m1, m2];
  const metricsTop = 958;
  return (
    <>
      <ScreenBox file={file} />
      <div style={{ position: 'absolute', top: metricsTop, left: 20, width: 1040, display: 'flex', gap: 12 }}>
        {metrics.map((m, i) => (
          <div
            key={m.k}
            style={{
              ...ms[i], flex: 1, padding: '17px 20px', borderRadius: 12,
              background: 'rgba(255,255,255,0.04)', border: `1px solid ${ACCENT}22`,
            }}
          >
            <div style={{ fontFamily: MONO, fontSize: 19, color: DIM, marginBottom: 6 }}>{m.k}</div>
            <div style={{ fontFamily: SANS, fontSize: 25, color: TEXT, fontWeight: 700 }}>{m.v}</div>
          </div>
        ))}
      </div>
      {note ? (
        <div
          style={{
            ...noteSt, position: 'absolute', top: 1086, left: 20, width: 1040,
            padding: '18px 24px', borderRadius: 12, backgroundColor: `${noteHot ? HOT : ACCENT}10`,
            border: `1px solid ${noteHot ? HOT : ACCENT}44`,
            fontFamily: SANS, fontSize: 26, color: TEXT, fontWeight: 700,
          }}
        >
          {note}
        </div>
      ) : null}
    </>
  );
};

/** 原理图场景 */
const SceneSch = () => {
  const { from } = sceneFrames('sch');
  const p = (useCurrentFrame() + from) / TOTAL_FRAMES;
  return (
    <SceneShell progress={p} caption="真实操作录像 · 无人值守" step={1} total={5} label="原理图连线">
      <ScreenScene
        file="01_sch.mp4"
        metrics={[
          { k: '器件', v: '自动选型' },
          { k: '引脚', v: '逐脚接线' },
          { k: '网络', v: '零遗漏' },
        ]}
        note="原理图 → 器件落位 → 引脚拉线，全程自动"
      />
      <StepTracker active={1} top={1180} />
    </SceneShell>
  );
};

/** 同步到 PCB */
const ScenePcbImp = () => {
  const { from } = sceneFrames('pcbimp');
  const p = (useCurrentFrame() + from) / TOTAL_FRAMES;
  return (
    <SceneShell progress={p} caption="原理图变更 → PCB 导入" step={2} total={5} label="同步到 PCB">
      <ScreenScene
        file="02_pcbimp.mp4"
        metrics={[
          { k: '来源', v: '原理图' },
          { k: '操作', v: '自动同步' },
          { k: '对齐', v: '无需手动' },
        ]}
        note="原理图怎么改，板子就怎么变"
      />
      <StepTracker active={2} top={1180} />
    </SceneShell>
  );
};

/** 自动布局 + 铺铜 */
const SceneLayout = () => {
  const { from } = sceneFrames('layout');
  const p = (useCurrentFrame() + from) / TOTAL_FRAMES;
  return (
    <SceneShell progress={p} caption="器件排布 · GND 双面覆铜" step={3} total={5} label="自动布局 + 铺铜">
      <ScreenScene
        file="03_layout.mp4"
        metrics={[
          { k: '布局', v: '按电气关系' },
          { k: '覆铜', v: '上下两层' },
          { k: '地网络', v: '自动打通' },
        ]}
        note="器件自己找位置，两层地铺满"
      />
      <StepTracker active={3} top={1180} />
    </SceneShell>
  );
};

/** 自动布线 */
const SceneRoute = () => {
  const { from } = sceneFrames('route');
  const p = (useCurrentFrame() + from) / TOTAL_FRAMES;
  return (
    <SceneShell progress={p} caption="走线 · 过孔 · 全自动" step={4} total={5} label="自动布线">
      <ScreenScene
        file="04_pour.mp4"
        metrics={[
          { k: '信号线', v: '自动走' },
          { k: '电源线', v: '自动走' },
          { k: '过孔', v: '自动打' },
        ]}
        note={<>最费眼睛的一步，它<span style={{ color: HOT }}>几秒钟</span>干完</>}
        noteHot
      />
      <StepTracker active={4} top={1180} />
    </SceneShell>
  );
};

/** DRC 清间距 */
const SceneDrc = () => {
  const { from } = sceneFrames('drc');
  const p = (useCurrentFrame() + from) / TOTAL_FRAMES;
  return (
    <SceneShell progress={p} caption="间距不够就退回重走" step={5} total={5} label="DRC 查间距">
      <ScreenScene
        file="05_route.mp4"
        metrics={[
          { k: '规则', v: '1oz 铜厚' },
          { k: '违反', v: '自动重修' },
          { k: '结果', v: '零违规' },
        ]}
        note={<>规则没过，它<span style={{ color: HOT }}>不会假装通过</span></>}
        noteHot
      />
      <StepTracker active={5} top={1180} />
    </SceneShell>
  );
};

/** 完成：DRC 零违规 + 制造文件 */
const SceneFinal = () => {
  const { from } = sceneFrames('final');
  const p = (useCurrentFrame() + from) / TOTAL_FRAMES;
  const ok = useEnter(24);
  return (
    <SceneShell progress={p} caption="DRC 通过 · 制造文件一次导出" step={5} total={5} label="完成">
      <ScreenBox file="06_final.mp4" />
      <div
        style={{
          ...ok, position: 'absolute', top: 958, left: 20, width: 1040,
          padding: '24px 28px', borderRadius: 16, backgroundColor: `${ACCENT}14`,
          border: `2px solid ${ACCENT}66`, display: 'flex', alignItems: 'center', gap: 20,
        }}
      >
        <div
          style={{
            width: 54, height: 54, borderRadius: 27, background: ACCENT,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 30, fontWeight: 800, color: '#04121f',
          }}
        >
          ✓
        </div>
        <div>
          <div style={{ fontFamily: SANS, fontSize: 32, fontWeight: 800, color: TEXT }}>DRC 零违规</div>
          <div style={{ fontFamily: MONO, fontSize: 22, color: DIM, marginTop: 5 }}>制造文件 · BOM · 坐标文件</div>
        </div>
      </div>
      <div style={{ position: 'absolute', top: 1086, left: 20, width: 1040, display: 'flex', gap: 12 }}>
        {[
          { k: 'GERBER', v: '已导出' },
          { k: 'BOM', v: '已导出' },
          { k: 'PnP', v: '已导出' },
        ].map((m) => (
          <div
            key={m.k}
            style={{
              flex: 1, padding: '17px 20px', borderRadius: 12,
              background: 'rgba(255,255,255,0.04)', border: `1px solid ${ACCENT}22`,
            }}
          >
            <div style={{ fontFamily: MONO, fontSize: 19, color: DIM, marginBottom: 6 }}>{m.k}</div>
            <div style={{ fontFamily: SANS, fontSize: 25, color: ACCENT, fontWeight: 700 }}>{m.v}</div>
          </div>
        ))}
      </div>
      <StepTracker active={5} top={1180} />
    </SceneShell>
  );
};

/** 结尾：零人工干预 + 流水线在跑 */
const SceneEnd = () => {
  const a = useEnter(4);
  const b = useEnter(40);
  const c = useEnter(96);
  const frame = useCurrentFrame();
  const pulse = 0.5 + 0.5 * Math.sin(frame / 16);
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', padding: '0 60px' }}>
      <div
        style={{
          position: 'absolute', width: 700, height: 700, borderRadius: 350,
          background: `radial-gradient(circle, ${ACCENT}${pulse > 0.5 ? '26' : '1c'} 0%, transparent 68%)`,
        }}
      />
      <div style={{ ...a, fontFamily: SANS, fontSize: 74, fontWeight: 800, color: TEXT, textAlign: 'center', lineHeight: 1.32 }}>
        从想法到打样板
        <br />
        <span style={{ color: ACCENT }}>零人工干预</span>
      </div>
      <div
        style={{
          ...b, marginTop: 54, width: '100%', padding: '30px 32px', borderRadius: 20,
          backgroundColor: PANEL, border: '1px solid rgba(255,255,255,0.10)',
        }}
      >
        {[
          ['原理图', '自动'],
          ['布局布线', '自动'],
          ['DRC', '自动'],
          ['制造文件', '自动'],
        ].map(([k, v], i) => (
          <div
            key={k}
            style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '14px 0',
              borderBottom: i < 3 ? '1px solid rgba(255,255,255,0.06)' : 'none',
            }}
          >
            <span style={{ fontFamily: MONO, fontSize: 28, color: DIM }}>{k}</span>
            <span style={{ fontFamily: SANS, fontSize: 30, fontWeight: 800, color: ACCENT }}>{v}</span>
          </div>
        ))}
      </div>
      <div style={{ ...c, marginTop: 46, fontFamily: SANS, fontSize: 40, fontWeight: 800, color: TEXT, textAlign: 'center' }}>
        这套流水线，现在就在跑
      </div>
    </AbsoluteFill>
  );
};

// ─────────────── 主组件 ───────────────

export const PcbRealV6 = () => {
  const cuts = [
    [sceneFrames('title').from, sceneFrames('title').to, <SceneTitle />],
    [sceneFrames('hook').from, sceneFrames('hook').to, <SceneHook />],
    [sceneFrames('sch').from, sceneFrames('sch').to, <SceneSch />],
    [sceneFrames('pcbimp').from, sceneFrames('pcbimp').to, <ScenePcbImp />],
    [sceneFrames('layout').from, sceneFrames('layout').to, <SceneLayout />],
    [sceneFrames('route').from, sceneFrames('route').to, <SceneRoute />],
    [sceneFrames('drc').from, sceneFrames('drc').to, <SceneDrc />],
    [sceneFrames('final').from, sceneFrames('final').to, <SceneFinal />],
    [sceneFrames('end').from, TOTAL_FRAMES, <SceneEnd />],
  ];
  return (
    <AbsoluteFill style={{ backgroundColor: BG }}>
      {/* 神经语音配音：zh-CN-YunxiNeural，实测 -17.5 LUFS / -4.5 dBTP */}
      <Audio src={staticFile('voice_pcb.wav')} volume={1} />
      {/* BGM：与 V6 版 Rust Seek 同一首《运气的形状》，同一条手机外放 EQ 链
          （highpass 70 + 900/2400/4200Hz 强抬 + 120Hz 微降），-18 LUFS 母带。
          volume 0.78：实测人声空档约 -22.4dB（规范 ≥-24），
          成片真峰值 -1.5 dBTP（0.85 时会顶到 -0.7，平台转码有削波风险）。 */}
      <Audio src={staticFile('bgm_pcb_v6.wav')} volume={0.78} />
      <Backdrop />
      {cuts.map(([from, to, node], i) => (
        <Sequence key={i} from={from} durationInFrames={Math.max(1, to - from)}>
          <SceneTransition>{node}</SceneTransition>
        </Sequence>
      ))}
      <Captions fontSize={56} />
    </AbsoluteFill>
  );
};

export const PCB_V6_TOTAL_FRAMES = TOTAL_FRAMES;
