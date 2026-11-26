/**
 * `@deepseek-ai/schemastery` 的最小桩。
 *
 * 插件只用到 `z.object({ root: z.string(), timeoutMs: z.number() })`
 * 以及 `Config` 能不能被构造出来。所以这里只需要能记录 shape，
 * 并把字段标成「可选」——插件里两个字段都**不是** required。
 *
 * 如果哪天有人给它们加了 `.required()`，这个桩会如实报出来，
 * 因为插件的行为必须和桩的语义一致，否则在真 DSH 里就是另一种样子。
 */

const make = (type) => {
  // 注意：不能把 required 同时当布尔字段和方法用 —— 先写 `required: false`
  // 再赋一个函数，前者会被后者覆盖，断言就永远看到函数而不是缺省值。
  // 真实 schemastery 里 `z.string()` 默认可选，`.required()` 才变必填。
  const node = {
    type,
    __required: false,
    required() { return { ...node, __required: true } },
    description() { return { ...node } },
  }
  return node
}

export const string = () => make('string')
export const number = () => make('number')
export const boolean = () => make('boolean')

export function object(shape = {}) {
  return {
    type: 'object',
    shape,
    /** 桩不校验，只暴露 shape 供断言。 */
    __shape: shape,
  }
}

export default { object, string, number, boolean }
