/**
 * DeepSeek Harness 插件：把 pcb-auto 的 5 个操作暴露成 Cordis 工具。
 *
 * 架构：本文件是**薄壳**。真正的实现在 `${root}/core/ops.mjs`，同一份代码同时驱动
 *   - DSH 插件（本文件）
 *   - MCP 服务器（mcp/server.mjs）
 *   - 通用 CLI（cli/pcb.mjs）
 * 一层实现，三种外壳。不复制逻辑，因为复制出来的两个版本一定会漂移。
 *
 * 为什么运行时动态 import 而不是打包进来：这样插件永远跑在仓库**当前**的代码上。
 * 如果把它打进来，用户升级了仓库但插件用的还是旧副本 —— 那就出现了「文档说 A、插件做 B」。
 *
 * @module @pcb-auto/dsh-plugin
 */

import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { locateRoot } from './locate-root.mjs'

export const name = 'pcb-auto'

/** 只需要工具注册表这一个服务。 */
export const inject = ['tools']

export const Config = z.object({
  /**
   * pcb-auto 仓库的绝对路径。**通常不用填** —— 默认自动探测（见 locate-root.mjs）。
   */
  root: z.string(),
  /** 单次 build 的硬上限。 */
  timeoutMs: z.number(),
})

const DEFAULT_TIMEOUT = 45 * 60 * 1000

/**
 * 把 core 的参数声明翻译成 DSH 的参数 DSL。两边字段一致，只是形状不同。
 * @param {Record<string, {type: string, required?: boolean, description?: string}>} spec
 */
function toParams(spec) {
  const out = {}
  for (const [k, v] of Object.entries(spec)) {
    out[k] = { type: v.type === 'integer' ? 'number' : v.type, description: v.description || '' }
    if (v.required) out[k].required = true
  }
  return out
}

/** 每个操作怎么渲染给模型看。渲染是**展示**，不是判定 —— 判定看 exitCode。 */
const RENDER = {
  'idea-to-design': (_a, v) => [{
    type: 'text',
    text: v.ok
      ? `设计 ${v.complexity}：${v.components} 器件 / ${v.connections} 连接 / ${v.nets} 网络` +
        (v.path ? `\n  → ${v.path}` : '\n  (dry，未写盘)') + `\n  网络：${v.netsList}\n  ${v.parts}`
      : `编译被拒绝（exit ${v.exitCode}）：\n${v.reason}`,
  }],
  build: (_a, v) => [{
    type: 'text',
    text: `${v.ok ? 'PASS' : 'FAIL'}  ${v.designName || '?'}  ${v.elapsedSec ?? '?'}s  策略=${v.strategy || '?'}\n`
      + `  DRC ${v.drcPassed ? '通过' : '未通过'}（${v.drcViolations} 条）  导出 ${v.exportsOk}/${v.exportsTotal}\n`
      + `  → ${v.runDir || '(未找到产物目录)'}`
      + (v.ok ? '' : `\n\n${String(v.detail || '').slice(-900)}`)
      + '\n\n注意：这里的 ok 是**流水线自述**，不是可下单。要判断能不能下单请调 pcb_fabcheck。',
  }],
  fabcheck: (_a, v) => [{
    type: 'text',
    text: v.orderable
      ? `可下单  ${v.dir}（0 阻断 / ${v.warningCount} 警告）`
      : `不可下单  ${v.dir}（${v.blockerCount} 阻断 / ${v.warningCount} 警告）\n  `
        + (v.blockers || v.raw || '').split('\n').slice(0, 12).join('\n  '),
  }],
  census: (_a, v) => [{
    type: 'text',
    text: `普查（${v.at}）：${v.dirs} 目录 → 可打样 ${v.fabOk} / 有阻断 ${v.blocked} / 解析错 ${v.parseErrors}`
      + (v.inFlight ? `（在飞跳过 ${v.inFlight}）` : '')
      + (v.selfOkTrue ? `\n  自述 ok=true：${v.selfOkTrueOk}/${v.selfOkTrue}` : '')
      + (v.blockerIds ? `\n  阻断类型：${v.blockerIds}` : '')
      + `\n  分母是这个时刻已沉淀的目录；settle 窗口不同分母会变，引用时必须带上时刻。`,
  }],
  verify: (_a, v) => [{
    type: 'text',
    text: `${v.verdict}  PASS ${v.pass} / INFO ${v.info} / WARN ${v.warn} / FAIL ${v.fail} / ERROR ${v.error}`
      + (v.failures ? `\n${v.failures}` : ''),
  }],
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} config
 */
export async function apply(ctx, config) {
  const { root, how } = locateRoot(config)
  const corePath = join(root, 'core', 'ops.mjs')

  // 动态 import：插件跟着仓库代码走，不是一个会过期的副本。
  const core = await import(pathToFileURL(corePath).href)
  const { OPS, dispatch } = core

  if (process.env.PCB_AUTO_VERBOSE) {
    process.stderr.write(`[pcb-auto] 仓库根 = ${root}（来源：${how}）\n`)
  }

  for (const [opName, op] of Object.entries(OPS)) {
    const toolName = `pcb_${opName.replace(/-/g, '_')}`
    ctx.tools.register(defineTool({
      name: toolName,
      description: `${op.summary}\n\n${op.summaryEn}\n\n`
        + '判定规则：exitCode 0 = 通过，1 = 结论为「否」（这是**结果**不是错误），2 = 调用参数有问题。',
      parameters: toParams(op.args),
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            exitCode: { type: 'integer', required: true },
            at: { type: 'string', description: '本次测量的时刻（ISO 8601）' },
          },
        },
        render: RENDER[opName] || ((_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }]),
      },
      async execute(args, exec) {
        return dispatch(opName, args, {
          root,
          signal: exec.signal,
          timeoutMs: config.timeoutMs || DEFAULT_TIMEOUT,
        })
      },
    }))
  }
}
