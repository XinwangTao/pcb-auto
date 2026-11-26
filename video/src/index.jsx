import React from 'react';
import { Composition } from 'remotion';
import { PcbAuto } from './Root.jsx';
import { PcbReal, REAL_TOTAL_FRAMES } from './RealRoot.jsx';
import { PcbRealV6, PCB_V6_TOTAL_FRAMES } from './PcbRealV6.jsx';
import { PcbRealV7, PCB_V7_TOTAL_FRAMES } from './PcbRealV7.jsx';
import { PcbRealV9, PCB_V9_TOTAL_FRAMES } from './PcbRealV9.jsx';
import { VIDEO } from './theme.js';

export const RemotionRoot = () => (
  <>
    <Composition
      id="PcbAuto"
      component={PcbAuto}
      durationInFrames={VIDEO.durationInFrames}
      fps={VIDEO.fps}
      width={VIDEO.width}
      height={VIDEO.height}
    />
    {/* 真实录屏版：画面是 AI 操作嘉立创EDA 的真实屏幕录像 */}
    <Composition
      id="PcbReal"
      component={PcbReal}
      durationInFrames={REAL_TOTAL_FRAMES}
      fps={30}
      width={1080}
      height={1920}
    />
    {/* 出品级版本：神经语音配音 + 逐字字幕 + BGM + 真实录屏 */}
    <Composition
      id="PcbRealV6"
      component={PcbRealV6}
      durationInFrames={PCB_V6_TOTAL_FRAMES}
      fps={30}
      width={1080}
      height={1920}
    />
    {/* 真实帧版：主素材是 EDA 自己渲染的画布 PNG（out/frames/<HHmmss>/），
        没有真实帧时自动退回 out/stills/ 占位。素材发现见 v7/prepare.mjs */}
    <Composition
      id="PcbRealV7"
      component={PcbRealV7}
      durationInFrames={PCB_V7_TOTAL_FRAMES}
      fps={30}
      width={1080}
      height={1920}
      defaultCodec="h264"
      defaultPixelFormat="yuv420p"
    />
    {/* V9 整夜版：段表跨批次（含失败批次），台词逐句由 _run.json/log 背书；
        视频轨只带人声，BGM 由 out/_probe/ship-v9.ps1 在混音时挂一次。
        段数 11 → SEG 96 / XF 11 / 946 帧 = 31.533s，全部由 manifest 推导。 */}
    <Composition
      id="PcbRealV9"
      component={PcbRealV9}
      durationInFrames={PCB_V9_TOTAL_FRAMES}
      fps={30}
      width={1080}
      height={1920}
      defaultCodec="h264"
      defaultPixelFormat="yuv420p"
    />
  </>
);
