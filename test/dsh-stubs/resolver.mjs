/**
 * 解析钩子：把 DSH 的两个宿主包指向本地桩。
 *
 * 为什么需要它：`plugin/index.js` 里写的是
 *
 *     import { defineTool } from '@deepseek-ai/dsh-tools'
 *     import z from '@deepseek-ai/schemastery'
 *
 * 这两个包只存在于 DSH 进程里。于是插件**在 DSH 之外根本 import 不了**，
 * 也就没法在 CI 上测 —— 而「插件能不能注册出 5 个工具」恰恰是最该测的东西。
 *
 * 做法：不复制插件源码，只替换这两个 import 的解析结果。
 * 被测的仍然是仓库里那一份 `plugin/index.js`，一字不改。
 *
 * @module pcb-auto/test/dsh-stubs/resolver
 */

const STUBS = {
  '@deepseek-ai/dsh-tools': new URL('./dsh-tools.mjs', import.meta.url).href,
  '@deepseek-ai/schemastery': new URL('./schemastery.mjs', import.meta.url).href,
}

export async function resolve(specifier, context, next) {
  if (STUBS[specifier]) {
    return { url: STUBS[specifier], shortCircuit: true, format: 'module' }
  }
  return next(specifier, context)
}
