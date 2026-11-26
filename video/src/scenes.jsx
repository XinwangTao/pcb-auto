import React from 'react';
import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { C, Chip, Divider } from './ui.jsx';
import { FONT } from './fonts.js';
import data from './data.json';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' };
const easeOut = (f, a, b) => interpolate(f, [a, b], [0, 1], clamp);

/**
 * 竖屏安全区：短视频平台上下各有 UI 遮挡，内容收在 150→1700 之间，
 * 并让每个分镜用 flex 撑满安全区，避免「上半屏有内容、下半屏空白」。
 */
const SAFE = { paddingTop: 150, paddingBottom: 220, paddingLeft: 76, paddingRight: 76 };

const rise = (f, start, dur = 22, dist = 40) => {
  const p = spring({
    frame: f - start,
    fps: 60,
    config: { damping: 200, mass: 0.6 },
    durationInFrames: dur,
  });
  // 透明度不从 0 起步：硬切后若从 0 渐显，切点后头几帧几乎空白（观感像闪黑）。
  // 给 0.35 基线并缩短上浮距离，保证每一帧都有可辨识内容。
  const op = 0.35 + 0.65 * p;
  const dy = (1 - p) * dist * 0.5;
  return { opacity: op, transform: `translateY(${dy}px)` };
};

/** 程序化对勾，不依赖 emoji / 符号字体 */
const Check = ({ size = 56, color = C.green, progress = 1 }) => {
  const len = 34;
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" style={{ flexShrink: 0 }}>
      <circle
        cx="24"
        cy="24"
        r="21"
        fill={`${color}18`}
        stroke={color}
        strokeWidth="3"
        strokeDasharray={132}
        strokeDashoffset={132 * (1 - Math.min(1, progress * 1.6))}
      />
      <path
        d="M14 25 L21 32 L34 18"
        fill="none"
        stroke={color}
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={len}
        strokeDashoffset={len * (1 - Math.max(0, Math.min(1, (progress - 0.25) / 0.75)))}
      />
    </svg>
  );
};

/** 真实布线图做暗底：径向遮罩淡出四边，不露图片矩形边界 */
const BoardGhost = ({ width = 1180, left = -50, top = 380, opacity = 0.1 }) => (
  <Img
    src={staticFile('board/hi_page3.png')}
    style={{
      position: 'absolute',
      width,
      left,
      top,
      opacity,
      filter: 'invert(1) hue-rotate(180deg) brightness(1.9)',
      maskImage:
        'radial-gradient(58% 58% at 50% 50%, #000 0%, #000 40%, transparent 76%)',
      WebkitMaskImage:
        'radial-gradient(58% 58% at 50% 50%, #000 0%, #000 40%, transparent 76%)',
    }}
  />
);

/** 数据大字：用雅黑而非 Consolas —— Consolas 的 0 带斜杠，会被误读成「Ø」 */
const BigNum = ({ children, size = 86, color = C.green }) => (
  <span
    style={{
      fontSize: size,
      fontWeight: 700,
      color,
      lineHeight: 1,
      letterSpacing: -2,
      fontFamily: FONT.sans,
    }}
  >
    {children}
  </span>
);

/* ---------------------------------------------------------- 1. 开场 ---- */

export const Hook = () => {
  const f = useCurrentFrame();
  const lines = ['一句话，', 'AI 画完', '一块 PCB'];
  return (
    <AbsoluteFill style={{ fontFamily: FONT.sans, color: C.ink, ...SAFE }}>
      <BoardGhost opacity={0.12 * easeOut(f, 10, 70)} />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          paddingTop: SAFE.paddingTop,
          paddingBottom: SAFE.paddingBottom,
          paddingLeft: SAFE.paddingLeft,
          paddingRight: SAFE.paddingRight,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ ...rise(f, 0, 26), marginBottom: 46 }}>
          <Chip>AI × PCB · 全自动流水线</Chip>
        </div>

        {lines.map((t, i) => {
          const st = 8 + i * 12;
          const p = spring({
            frame: f - st,
            fps: 60,
            config: { damping: 200, mass: 0.7 },
            durationInFrames: 30,
          });
          return (
            <div
              key={t}
              style={{
                fontSize: i === 0 ? 128 : 146,
                fontWeight: 700,
                lineHeight: 1.24,
                letterSpacing: -3,
                opacity: 0.35 + 0.65 * p,
                transform: `translateY(${(1 - p) * 46}px)`,
                color: i === 2 ? C.accent : C.ink,
                textShadow: i === 2 ? `0 0 70px ${C.accent}66` : 'none',
                whiteSpace: 'nowrap',
              }}
            >
              {t}
            </div>
          );
        })}

        <div style={{ ...rise(f, 46, 26), marginTop: 66 }}>
          <Divider style={{ opacity: 0.75, marginBottom: 34 }} />
          <div style={{ fontSize: 48, color: '#b9c6e4', letterSpacing: 3 }}>
            零人工干预 · 从一句话到可打样
          </div>
        </div>

        <div
          style={{
            ...rise(f, 64, 26),
            marginTop: 96,
            display: 'flex',
            gap: 18,
          }}
        >
          {[
            { k: data.componentCount, u: '器件' },
            { k: data.netCount, u: '网络' },
            { k: data.phaseCount, u: '阶段' },
            { k: `${data.elapsedSec}s`, u: '总耗时' },
          ].map((x) => (
            <div
              key={x.u}
              style={{
                flex: 1,
                padding: '26px 10px',
                borderRadius: 22,
                border: `2px solid ${C.faint}`,
                background: 'rgba(10,16,32,0.75)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <span
                style={{
                  fontSize: 50,
                  fontWeight: 700,
                  color: C.ink,
                  lineHeight: 1.1,
                  letterSpacing: -1,
                }}
              >
                {x.k}
              </span>
              <span style={{ fontSize: 26, color: C.dim }}>{x.u}</span>
            </div>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* -------------------------------------------------- 2. 想法输入 ---- */

export const IdeaInput = () => {
  const f = useCurrentFrame();
  const idea = data.idea;
  // 本镜只有 480 帧：打字早收（110 帧 ≈ 1.8s），下面立刻接解析结果。
  // 器件/网络先用「骨架」占位再点亮，避免打字阶段下半屏出现大片空白。
  const typeEnd = 110;
  const shown = Math.min(idea.length, Math.floor((f / typeEnd) * idea.length * 1.12));
  const caretOn = Math.floor(f / 16) % 2 === 0 && f < typeEnd + 40;
  const parsedAt = typeEnd - 40; // 解析结果骨架屏出现
  const typed = f >= typeEnd;

  return (
    <AbsoluteFill
      style={{ fontFamily: FONT.sans, color: C.ink, ...SAFE }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          paddingTop: SAFE.paddingTop,
          paddingBottom: SAFE.paddingBottom,
          paddingLeft: SAFE.paddingLeft,
          paddingRight: SAFE.paddingRight,
          display: 'flex',
          flexDirection: 'column',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ ...rise(f, 0, 22) }}>
          <Chip color={C.accent2}>02 · 想法输入</Chip>
        </div>
        <div
          style={{
            ...rise(f, 8, 24),
            fontSize: 68,
            fontWeight: 700,
            marginTop: 34,
            letterSpacing: -1,
          }}
        >
          人类只写一句话
        </div>

        {/* 自然语言输入框 */}
        <div
          style={{
            marginTop: 44,
            padding: '40px 38px 44px',
            borderRadius: 28,
            border: `2px solid ${C.accent2}66`,
            background: 'rgba(124,107,255,0.08)',
          }}
        >
          <div
            style={{
              fontSize: 28,
              color: '#a99cff',
              letterSpacing: 1,
              marginBottom: 24,
              fontFamily: FONT.mono,
            }}
          >
            designs\{data.designId}.json
          </div>
          <div style={{ fontSize: 48, lineHeight: 1.68, color: '#e2e9ff' }}>
            {idea.slice(0, shown)}
            <span
              style={{
                display: 'inline-block',
                width: 5,
                height: 50,
                background: C.accent,
                marginLeft: 5,
                verticalAlign: '-8px',
                opacity: caretOn ? 1 : 0,
              }}
            />
          </div>
        </div>

        {/* 解析结果：真实器件表（骨架 → 点亮） */}
        <div style={{ ...rise(f, parsedAt, 26), marginTop: 64 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              marginBottom: 24,
            }}
          >
            <span style={{ fontSize: 42, color: '#c3cfe8', letterSpacing: 1 }}>
              解析出{' '}
              <span
                style={{
                  color: typed ? C.accent : C.faint,
                  fontWeight: 700,
                  transition: 'none',
                }}
              >
                {data.componentCount}
              </span>{' '}
              个器件
            </span>
            <span style={{ fontSize: 32, color: C.dim, fontFamily: FONT.mono }}>
              {data.connectionCount} 条连接
            </span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 15 }}>
            {data.components.map((c, i) => {
              const lit = easeOut(f, typeEnd + i * 5, typeEnd + 18 + i * 5);
              return (
                <div
                  key={c.des}
                  style={{
                    padding: '15px 23px',
                    borderRadius: 16,
                    background: `rgba(77,184,255,${0.04 + 0.07 * lit})`,
                    border: `2px solid rgba(77,184,255,${0.18 + 0.24 * lit})`,
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 12,
                  }}
                >
                  <span
                    style={{
                      fontSize: 35,
                      fontWeight: 700,
                      color: `rgba(77,184,255,${0.35 + 0.65 * lit})`,
                      fontFamily: FONT.mono,
                    }}
                  >
                    {c.des}
                  </span>
                  <span
                    style={{
                      fontSize: 29,
                      color: `rgba(167,181,212,${0.3 + 0.7 * lit})`,
                    }}
                  >
                    {c.value}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* 真实网络 */}
        <div style={{ ...rise(f, parsedAt + 34, 26), marginTop: 64 }}>
          <div
            style={{
              fontSize: 42,
              color: '#c3cfe8',
              letterSpacing: 1,
              marginBottom: 24,
            }}
          >
            识别出{' '}
            <span style={{ color: typed ? C.green : C.faint, fontWeight: 700 }}>
              {data.netCount}
            </span>{' '}
            条网络
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 15 }}>
            {data.nets.map((n, i) => {
              const lit = easeOut(f, typeEnd + 26 + i * 6, typeEnd + 52 + i * 6);
              return (
                <div
                  key={n}
                  style={{
                    padding: '15px 27px',
                    borderRadius: 14,
                    background: `rgba(53,224,161,${0.04 + 0.06 * lit})`,
                    border: `2px solid rgba(53,224,161,${0.18 + 0.22 * lit})`,
                    fontSize: 35,
                    fontFamily: FONT.mono,
                    fontWeight: 700,
                    color: `rgba(53,224,161,${0.35 + 0.65 * lit})`,
                  }}
                >
                  {n}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ------------------------------------------------ 3. 流水线 ---- */

// 零耗时阶段给最小节拍，保证视觉上能看清
const FLOOR = 300;
const seqDur = data.phases.map((p) => Math.max(p.dur, FLOOR));
const seqTotal = seqDur.reduce((a, b) => a + b, 0);
const revealFraction = [];
{
  let acc = 0;
  for (const d of seqDur) {
    revealFraction.push(acc / seqTotal);
    acc += d;
  }
}

export const Pipeline = () => {
  const f = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const START = 26;
  const SPAN = durationInFrames - 100;

  const litCount = data.phases.filter(
    (_, i) => f >= START + revealFraction[i] * SPAN
  ).length;

  const activeCum =
    litCount > 0 ? data.phases[Math.min(litCount, data.phases.length) - 1].cum : 0;
  const maxBar = Math.max(...data.phases.map((p) => p.dur));

  return (
    <AbsoluteFill style={{ fontFamily: FONT.sans, color: C.ink, ...SAFE }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          paddingTop: SAFE.paddingTop,
          paddingBottom: SAFE.paddingBottom,
          paddingLeft: SAFE.paddingLeft,
          paddingRight: SAFE.paddingRight,
          display: 'flex',
          flexDirection: 'column',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ ...rise(f, 0, 20) }}>
          <Chip>03 · 全流程自动化</Chip>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            marginTop: 32,
          }}
        >
          <div style={{ fontSize: 54, fontWeight: 700, letterSpacing: -1 }}>
            {data.phaseCount} 个阶段
          </div>
          <div
            style={{
              fontSize: 54,
              fontWeight: 700,
              color: C.accent,
              letterSpacing: -1,
            }}
          >
            {(activeCum / 1000).toFixed(1)}
            <span style={{ fontSize: 34, marginLeft: 4, color: C.dim }}>s</span>
          </div>
        </div>
        <Divider style={{ marginTop: 20, marginBottom: 26 }} />

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 13,
            flex: 1,
          }}
        >
          {data.phases.map((p, i) => {
            const at = START + revealFraction[i] * SPAN;
            const on = f >= at;
            const p2 = interpolate(f, [at, at + 14], [0, 1], clamp);
            const cur = i === litCount - 1;
            const w = maxBar > 0 ? p.dur / maxBar : 0;
            return (
              <div
                key={p.name}
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  paddingLeft: 22,
                  paddingRight: 20,
                  borderRadius: 16,
                  background: on
                    ? cur
                      ? 'rgba(77,184,255,0.15)'
                      : 'rgba(77,184,255,0.05)'
                    : 'transparent',
                  border: `2px solid ${on ? C.accent + (cur ? '66' : '38') : 'transparent'}`,
                  opacity: on ? 1 : 0.2,
                  transform: `translateX(${on ? 0 : -20}px)`,
                }}
              >
                <div
                  style={{
                    width: 40,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {on ? (
                    <Check size={38} progress={p2} />
                  ) : (
                    <div
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: 8,
                        border: `2px solid ${C.faint}`,
                      }}
                    />
                  )}
                </div>

                <div
                  style={{
                    flex: 1,
                    fontFamily: FONT.mono,
                    fontSize: 37,
                    color: on ? C.ink : C.dim,
                    letterSpacing: -0.5,
                  }}
                >
                  {p.name}
                </div>

                {/* 真实耗时占比条 */}
                <div
                  style={{
                    width: 118,
                    height: 10,
                    borderRadius: 5,
                    background: 'rgba(120,160,255,0.13)',
                    overflow: 'hidden',
                    flexShrink: 0,
                  }}
                >
                  <div
                    style={{
                      width: `${Math.min(100, Math.max(w * 100, p.dur === 0 ? 0 : 6) * p2)}%`,
                      height: '100%',
                      background: cur ? C.accent : '#3a86c8',
                      borderRadius: 5,
                    }}
                  />
                </div>

                <div
                  style={{
                    width: 108,
                    textAlign: 'right',
                    fontFamily: FONT.mono,
                    fontSize: 31,
                    color: on ? (cur ? C.accent : '#9fb0d0') : C.faint,
                    flexShrink: 0,
                  }}
                >
                  {p.dur === 0 ? '—' : `${(p.dur / 1000).toFixed(2)}s`}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ------------------------------------------------ 4. 产物 ---- */

export const Artifacts = () => {
  const f = useCurrentFrame();
  const items = data.artifacts;
  const STEP = 26;
  return (
    <AbsoluteFill style={{ fontFamily: FONT.sans, color: C.ink, ...SAFE }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          paddingTop: SAFE.paddingTop,
          paddingBottom: SAFE.paddingBottom,
          paddingLeft: SAFE.paddingLeft,
          paddingRight: SAFE.paddingRight,
          display: 'flex',
          flexDirection: 'column',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ ...rise(f, 0, 20) }}>
          <Chip color={C.green}>04 · 真实产物</Chip>
        </div>
        <div
          style={{
            ...rise(f, 8, 22),
            fontSize: 64,
            fontWeight: 700,
            marginTop: 32,
            letterSpacing: -1,
          }}
        >
          可下单的文件
        </div>
        <div style={{ ...rise(f, 14, 22), fontSize: 30, color: C.dim, marginTop: 14, fontFamily: FONT.mono }}>
          {data.outName}
        </div>

        <div
          style={{
            marginTop: 40,
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            flex: 1,
          }}
        >
          {items.map((a, i) => {
            const st = 30 + i * STEP;
            const p = spring({
              frame: f - st,
              fps: 60,
              config: { damping: 200, mass: 0.6 },
              durationInFrames: 24,
            });
            return (
              <div
                key={a.file}
                style={{
                  flex: 1,
                  opacity: 0.35 + 0.65 * p,
                  transform: `translateY(${(1 - p) * 34}px) scale(${0.96 + 0.04 * p})`,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 20,
                  padding: '0 26px',
                  borderRadius: 20,
                  background: 'rgba(53,224,161,0.055)',
                  border: `2px solid ${C.green}38`,
                }}
              >
                <div
                  style={{
                    width: 7,
                    height: '58%',
                    borderRadius: 4,
                    background: C.green,
                    flexShrink: 0,
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: FONT.mono,
                      fontSize: 39,
                      fontWeight: 700,
                      color: C.ink,
                    }}
                  >
                    {a.file}
                  </div>
                  <div style={{ fontSize: 27, color: '#93a4c4', marginTop: 5 }}>
                    {a.label} · {a.note}
                  </div>
                </div>
                <div
                  style={{
                    fontSize: 35,
                    color: C.green,
                    textAlign: 'right',
                    flexShrink: 0,
                    fontWeight: 700,
                  }}
                >
                  {a.human}
                </div>
              </div>
            );
          })}
        </div>

        <div
          style={{
            ...rise(f, 30 + items.length * STEP + 16, 26),
            marginTop: 26,
            fontSize: 27,
            color: '#6f7d9c',
            fontFamily: FONT.mono,
            textAlign: 'center',
          }}
        >
          Gerber.zip 内 {data.gerberEntries} 个文件 · 钻孔/丝印/钢网/飞针
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ------------------------------------------------ 5. 质量证明 ---- */

export const Quality = () => {
  const f = useCurrentFrame();
  const rows = [
    { label: 'PCB DRC 违规', value: data.drc.violations },
    { label: '原理图 DRC 错误', value: data.drc.schErrors },
    { label: '网表不一致', value: data.drc.mismatches },
  ];
  return (
    <AbsoluteFill style={{ fontFamily: FONT.sans, color: C.ink, ...SAFE }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          paddingTop: SAFE.paddingTop,
          paddingBottom: SAFE.paddingBottom,
          paddingLeft: SAFE.paddingLeft,
          paddingRight: SAFE.paddingRight,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ ...rise(f, 0, 20) }}>
          <Chip color={C.green}>05 · 质量证明</Chip>
        </div>
        <div
          style={{
            ...rise(f, 8, 22),
            fontSize: 72,
            fontWeight: 700,
            marginTop: 36,
            letterSpacing: -1,
          }}
        >
          机器自己验收过
        </div>

        <div
          style={{
            marginTop: 86,
            display: 'flex',
            flexDirection: 'column',
            gap: 40,
          }}
        >
          {rows.map((r, i) => {
            const st = 24 + i * 26;
            const p = spring({
              frame: f - st,
              fps: 60,
              config: { damping: 200, mass: 0.7 },
              durationInFrames: 26,
            });
            return (
              <div
                key={r.label}
                style={{
                  opacity: 0.35 + 0.65 * p,
                  transform: `translateY(${(1 - p) * 40}px)`,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 26,
                  padding: '46px 34px',
                  borderRadius: 28,
                  background: 'rgba(53,224,161,0.09)',
                  border: `2px solid ${C.green}5c`,
                  boxShadow: `0 0 70px ${C.green}1f`,
                }}
              >
                <Check size={76} progress={p} />
                <div
                  style={{ flex: 1, fontSize: 46, color: '#dcfaee', fontWeight: 700 }}
                >
                  {r.label}
                </div>
                <BigNum>{r.value}</BigNum>
              </div>
            );
          })}
        </div>

        <div
          style={{
            ...rise(f, 130, 26),
            marginTop: 76,
            padding: '32px 34px',
            borderRadius: 20,
            border: `2px dashed ${C.faint}`,
            fontSize: 30,
            color: '#9aa8c6',
            lineHeight: 1.75,
            textAlign: 'center',
          }}
        >
          {/* 【这一句曾经是硬编码的「DRC 全部通过」】
              它不由 data.json 驱动，所以哪怕钉住的 run 里 drc.passed=false、
              drcLeafCount=33，画面上照样写着「DRC 全部通过」。
              视频是发布物，这句话就是一句可被逐帧截图取证的假话 ——
              而它比一个 bug 更糟：bug 顶多让人修，假话会被人拿去当结论。
              现在按 drc.passed 分流，未通过时直接写违规数。 */}
          {data.drc.passed
            ? 'DRC 全部通过'
            : `DRC 未通过 · ${data.drc.violations} 处违规待修`}{' '}
          · {data.copperPours} 块铜皮灌注
          <br />
          {data.snappedLines} 条走线端点吸附 · {data.drc.schWarns} 条原理图告警
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ------------------------------------------------ 6. 收尾 ---- */

export const Outro = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        fontFamily: FONT.sans,
        color: C.ink,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 76,
      }}
    >
      <BoardGhost width={900} left={90} top={700} opacity={0.1} />
      <div style={{ ...rise(f, 4, 24), textAlign: 'center' }}>
        <div
          style={{
            fontSize: 108,
            fontWeight: 700,
            lineHeight: 1.26,
            letterSpacing: -3,
          }}
        >
          想法进，
          <br />
          <span style={{ color: C.accent }}>板子出。</span>
        </div>
      </div>

      <div style={{ ...rise(f, 34, 26), marginTop: 56, textAlign: 'center' }}>
        <Divider style={{ width: 440, margin: '0 auto 34px' }} />
        <div style={{ fontSize: 40, color: '#c3cfe8', letterSpacing: 5 }}>
          AI 全自动接管 PCB 设计
        </div>
      </div>

      <div
        style={{
          ...rise(f, 54, 26),
          marginTop: 130,
          textAlign: 'center',
          fontFamily: FONT.mono,
          fontSize: 25,
          color: '#67748f',
          lineHeight: 2,
        }}
      >
        <div style={{ color: '#8d9ab8' }}>pcb-auto · {data.designName}</div>
        <div>{data.outName}</div>
        <div>
          {data.componentCount} 器件 / {data.netCount} 网络 / {data.elapsedSec}s / DRC{' '}
          {data.drc.violations} 违规
        </div>
      </div>
    </AbsoluteFill>
  );
};
