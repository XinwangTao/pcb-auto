/**
 * V10 专用 CLI 配置：**故意是空的**。
 *
 * 目录里默认的 `remotion.config.js` 会在每次 CLI 启动时用子进程跑 `v7/prepare.mjs`，
 * 那个脚本会重扫 `out/frames` 的**最新**批次并覆盖 `public/v7/manifest.json` 与
 * `public/v7/real/*.png` —— 也就是 V7/V9 正片的素材。V10 不需要它，也不该顺手把
 * 别的合成的素材换掉。
 *
 * 用法（显式挂这个配置，就不会去加载 remotion.config.js）：
 *   npx remotion render src/entry.js PcbRealV10 out\v10-<HHmmss>.mp4 --config=remotion.config.v10.js
 */
module.exports = {};
