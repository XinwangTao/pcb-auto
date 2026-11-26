/**
 * 字体：完全由 CSS 提供（src/fonts.css 是 base64 内联的 @font-face）。
 *
 * 历史上试过两条路，都不如内联稳：
 *  1) 只写 font-family: 'Microsoft YaHei' —— 依赖 Chromium 命中系统字体，不可靠；
 *  2) staticFile() + new FontFace(...).load() —— Remotion 并发多 page 渲染时，
 *     部分 page 的字体请求会挂住，delayRender 在 442/3480 帧处超时崩掉。
 *
 * 内联 @font-face 由 CSS 解析器同步建好，截图前 document.fonts.ready 一定已 fulfilled，
 * 所以这里不需要任何 delayRender / 门控。
 */
export const FONT = {
  sans: '"YaHei", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif',
  mono: '"ConsolaLocal", "Consolas", "Courier New", monospace',
};
