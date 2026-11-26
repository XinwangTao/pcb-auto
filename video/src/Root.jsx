import React from 'react';
import {
  AbsoluteFill,
  Sequence,
  interpolate,
  useCurrentFrame,
} from 'remotion';
import { Backdrop, C } from './ui.jsx';
import { FONT } from './fonts.js';
import {
  Hook,
  IdeaInput,
  Pipeline,
  Artifacts,
  Quality,
  Outro,
} from './scenes.jsx';

// 分镜时间轴（60fps）。总 58s = 3480 帧。
const SCENES = [
  { id: 'hook', comp: Hook, from: 0, dur: 300 }, // 0–5.0s
  { id: 'idea', comp: IdeaInput, from: 300, dur: 480 }, // 5.0–13.0s
  { id: 'pipe', comp: Pipeline, from: 780, dur: 1200 }, // 13.0–33.0s
  { id: 'artf', comp: Artifacts, from: 1980, dur: 780 }, // 33.0–46.0s
  { id: 'qual', comp: Quality, from: 2760, dur: 480 }, // 46.0–54.0s
  { id: 'outr', comp: Outro, from: 3240, dur: 240 }, // 54.0–58.0s
];

const FADE = 16;

const SceneShell = ({ children, hue }) => (
  <AbsoluteFill>
    <Backdrop hue={hue} />
    <AbsoluteFill style={{ fontFamily: FONT.sans }}>{children}</AbsoluteFill>
  </AbsoluteFill>
);

export const PcbAuto = () => {
  const f = useCurrentFrame();

  return (
    <AbsoluteFill style={{ background: C.bg }}>
      {/* 硬切 + 轻微缩放推入。
          之前用透明度交叉淡变会同时露出两层内容 → 标题互相叠字（"05·质量证明"压在产物页上）；
          若让上层淡出到 0 又会露出近黑背景 → 出现纯黑帧。
          短视频平台本来就用硬切，这里改成每场景独立全不透明，靠 6 帧缩放做动感。 */}
      {SCENES.map((s) => {
        const local = f - s.from;
        if (local < 0 || local >= s.dur) return null;
        const scale = interpolate(local, [0, 6], [1.035, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
        return (
          <Sequence
            key={s.id}
            from={s.from}
            durationInFrames={s.dur}
            name={s.id}
          >
            <AbsoluteFill style={{ transform: `scale(${scale})` }}>
              <SceneShell hue={s.id === 'qual' || s.id === 'artf' ? 'green' : 'accent'}>
                <s.comp />
              </SceneShell>
            </AbsoluteFill>
          </Sequence>
        );
      })}
      {/* 开场：从黑淡入前 8 帧，避免第一帧生硬 */}
      <AbsoluteFill
        style={{
          background: '#000',
          opacity: interpolate(f, [0, 8], [1, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
          pointerEvents: 'none',
        }}
      />
      {/* 收尾：最后 20 帧淡出到黑，收束 */}
      <AbsoluteFill
        style={{
          background: '#000',
          opacity: interpolate(f, [3460, 3480], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
          pointerEvents: 'none',
        }}
      />
    </AbsoluteFill>
  );
};
