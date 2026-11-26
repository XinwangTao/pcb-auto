/**
 * Remotion CLI 配置。
 *
 * ⚠️ 本目录里原本只有 `remotion.config.mjs`，而 @remotion/cli 只解析
 * `remotion.config.ts` / `remotion.config.js`（见 cli/dist/get-config-file-name.js），
 * 所以那份 .mjs 从来没被执行过。这里新建 .js 只为挂上 PcbRealV7 的素材发现步骤，
 * **不复制** .mjs 里的 setVideoImageFormat / setConcurrency / setBrowserExecutable，
 * 否则会悄悄改变 PcbAuto / PcbReal / PcbRealV6 的渲染行为。
 *
 * prepare 用子进程跑（不 require 进来），原因有二：
 *   1) CLI 会把本文件用 esbuild 打成 CJS 再 eval，import.meta / .mjs 容易翻车；
 *   2) 子进程失败也只是 warn 一行，绝不会让老合成的 render 起不来。
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

try {
  const script = path.resolve(process.cwd(), 'v7', 'prepare.mjs');
  const r = spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (r.error) {
    console.warn('[v7] 素材发现跳过：', r.error.message);
  }
} catch (e) {
  console.warn('[v7] 素材发现跳过：', e && e.message ? e.message : e);
}
