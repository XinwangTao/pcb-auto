/**
 * `@deepseek-ai/dsh-tools` 的最小桩。
 *
 * 只实现插件真正用到的部分：`defineTool(def)` 原样返回定义对象。
 * 不模拟任何运行时行为 —— 这个桩的用途是**让插件能被 import 并调用 apply()**，
 * 不是假装 DSH 在这里。
 */

export function defineTool(def) {
  if (!def || typeof def !== 'object') throw new TypeError('defineTool 需要一个对象')
  if (typeof def.name !== 'string' || !def.name) throw new TypeError('工具必须有 name')
  if (typeof def.execute !== 'function') throw new TypeError(`工具 ${def.name} 缺少 execute`)
  if (!def.parameters || typeof def.parameters !== 'object') {
    throw new TypeError(`工具 ${def.name} 缺少 parameters`)
  }
  return def
}

export default { defineTool }
