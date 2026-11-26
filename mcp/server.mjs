#!/usr/bin/env node
/**
 * pcb-auto · MCP 服务器（零依赖）
 *
 * 一个通用的 Model Context Protocol stdio 服务器，只依赖 core/ops.mjs。
 * 因为它只说标准 MCP，所以**一个服务器覆盖所有 MCP 客户端**：Claude Code、Claude Desktop、
 * Cursor、Windsurf、VS Code Copilot、Zed、Cline、Roo Code、Continue、JetBrains AI、
 * Codex CLI、Gemini CLI、Qwen Code、OpenHands、Goose、Amazon Q、Aider(MCP 变体)…
 * 新出的客户端不需要我改一行代码。
 *
 * 协议：JSON-RPC 2.0，换行分隔，UTF-8；stdout **只**允许合法 MCP 消息，
 * 日志一律走 stderr（规范如此，否则客户端解析会崩）。
 *
 * 启动： node mcp/server.mjs
 * 或：   node mcp/server.mjs --root D:/path/to/pcb-auto
 */

import { createInterface } from 'node:readline'
import { OPS, dispatch, ROOT } from '../core/ops.mjs'

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const LATEST = SUPPORTED_VERSIONS[0]
const SERVER_INFO = { name: 'pcb-auto', title: 'PCB Auto', version: '1.0.0' }

/** @param {string} s */
const log = (s) => process.stderr.write(`[pcb-auto] ${s}\n`)

/** 把 core 的参数声明翻译成 JSON Schema（MCP 要的是 JSON Schema，不是自定义 DSL）。 */
function inputSchema(op) {
  const properties = {}
  const required = []
  for (const [k, v] of Object.entries(op.args)) {
    properties[k] = { type: v.type === 'integer' ? 'integer' : v.type, description: v.description || '' }
    if (v.required) required.push(k)
  }
  const s = { type: 'object', properties, additionalProperties: false }
  if (required.length) s.required = required
  return s
}

/** @param {string} name @param {any} op */
function toolDef(name, op) {
  return {
    name: `pcb_${name.replace(/-/g, '_')}`,
    title: op.summary,
    description: `${op.summary}\n\n${op.summaryEn}`,
    inputSchema: inputSchema(op),
    annotations: { readOnlyHint: name === 'fabcheck' || name === 'census' || name === 'verify', openWorldHint: false },
  }
}

const TOOLS = Object.entries(OPS).map(([n, o]) => toolDef(n, o))
const NAME_TO_OP = new Map(Object.keys(OPS).map((n) => [`pcb_${n.replace(/-/g, '_')}`, n]))

/** 在飞的调用，用于响应 notifications/cancelled。 */
const inflight = new Map()

/** @param {any} msg */
function send(msg) {
  // 规范要求：一行一条消息，不能含内嵌换行
  process.stdout.write(JSON.stringify(msg) + '\n')
}

/** @param {any} id @param {any} result */
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })

/** @param {any} id @param {number} code @param {string} message */
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

const INSTRUCTIONS = `pcb-auto 把「一句中文想法」变成「一块能下单的 PCB」。

五个工具的正确用法，以及三个**必须**知道的约束：

1. 顺序是 idea → build → fabcheck。不要跳过 fabcheck。
2. **判断能不能下单只能用 pcb_fabcheck 的退出码，不能用 build 返回的 ok。**
   build.ok 说的是「流水线自己跑完了没有」，fabcheck 说的是「这些文件能不能打样」。
   一块板可以流水线全绿但 Gerber 里铜几乎为零 —— 两者不一致是正常的，不是 bug。
3. 一块板最多试 4 次，每次换更大的板框。实测更大的板框**经常更差**，
   所以第 3、4 次失败后应当停止并如实报告，不要无限重试。

数据口径：所有涉及数量的回答都必须带上它是**哪一次、哪个时刻**的数字。
同一个语料用不同 settle 窗口会得到 56 / 55 / 54 三个都成立的目录数，
所以引用时必须说明分母和时刻，否则这个数字没有意义。

已知事实（截至 2026-11-26，可自行用 pcb_census 复核）：
- 56 个已沉淀产物目录：53 可打样，3 有阻断。
- **没有任何一块板被真正制造过。** 全部结论都是「文件层面可打样」。
- 从零画板（pcb_build）只有 Windows + 嘉立创 EDA 一条技术路线；pcb_idea_to_design /
  pcb_fabcheck / pcb_census 不依赖 Windows（Node ≥ 18.17；census 另需 Python 3）。`

/** @param {any} msg */
async function handle(msg) {
  const { id, method, params } = msg || {}

  // 通知（无 id）：不回复
  if (method && method.startsWith('notifications/')) {
    if (method === 'notifications/cancelled' && params && params.requestId != null) {
      const c = inflight.get(params.requestId)
      if (c) { c.abort(); inflight.delete(params.requestId) }
    }
    return
  }

  if (!method) { if (id !== undefined) fail(id, -32600, '无效请求：缺少 method'); return }

  switch (method) {
    case 'initialize': {
      const asked = params && params.protocolVersion
      // 版本协商：支持就原样回，否则回自己最新的
      const version = SUPPORTED_VERSIONS.includes(asked) ? asked : LATEST
      reply(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      })
      log(`initialize 完成（客户端 ${(params && params.clientInfo && params.clientInfo.name) || '?'}，协议 ${version}）`)
      return
    }
    case 'ping': reply(id, {}); return
    case 'tools/list': reply(id, { tools: TOOLS }); return
    case 'resources/list': reply(id, { resources: [] }); return
    case 'prompts/list': reply(id, { prompts: [] }); return

    case 'tools/call': {
      const name = params && params.name
      const opName = NAME_TO_OP.get(name)
      if (!opName) { fail(id, -32602, `未知工具：${name}`); return }

      const ctrl = new AbortController()
      if (id !== undefined) inflight.set(id, ctrl)
      try {
        const result = await dispatch(opName, (params && params.arguments) || {}, { root: ROOT, signal: ctrl.signal })
        const text = JSON.stringify(result, null, 2)
        // isError 只在**调用失败**时为 true；判定为「否」不是错误，
        // 它是一个正常结果，模型必须能读出 isError=false + orderable=false。
        const isError = result.exitCode === 2
        reply(id, {
          content: [{ type: 'text', text }],
          structuredContent: result,
          isError,
        })
      } catch (e) {
        reply(id, {
          content: [{ type: 'text', text: `[error] ${e && e.message ? e.message : e}` }],
          isError: true,
        })
      } finally {
        if (id !== undefined) inflight.delete(id)
      }
      return
    }
    default:
      if (id !== undefined) fail(id, -32601, `不支持的方法：${method}`)
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

/**
 * 还在处理中的请求。
 *
 * **为什么需要这个**：`spawnSync` 这类客户端会一次性写完所有消息再关 stdin。
 * 如果 `close` 一到就 `process.exit()`，那些正在跑的长任务（`build` 要 20 分钟，
 * `fabcheck` 要几百毫秒到几秒）的**回复会被丢掉** —— 客户端看到的是「没有响应」，
 * 而不是「失败」。这是最坏的一种错误：看起来像卡死。
 *
 * 所以 `close` 只表示「不会再有新请求」，不表示「不要回复了」。
 * 我们要把手上的活干完再退，并给一个硬上限防止真的挂住。
 */
const pending = new Set()

/** stdin 关闭后最多再等这么久，超时就放弃（防止某个子进程永不返回把服务器吊死）。 */
const DRAIN_CAP_MS = 60 * 60 * 1000

rl.on('line', (line) => {
  const s = line.trim()
  if (!s) return
  let msg
  try { msg = JSON.parse(s) } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } })
    return
  }
  const p = handle(msg)
    .catch((e) => log(`处理 ${msg && msg.method} 时抛错：${e && e.message ? e.message : e}`))
    .finally(() => pending.delete(p))
  pending.add(p)
})

let closing = false
rl.on('close', () => {
  if (closing) return
  closing = true

  if (pending.size === 0) {
    log('stdin 关闭，无在飞请求，退出')
    process.exit(0)
  }

  log(`stdin 关闭，还有 ${pending.size} 个请求在处理，等它们回复完再退（上限 ${DRAIN_CAP_MS / 60000} 分钟）`)

  const cap = new Promise((resolve) => {
    const t = setTimeout(() => {
      log(`等满了 ${DRAIN_CAP_MS / 60000} 分钟，放弃剩余 ${pending.size} 个请求`)
      resolve()
    }, DRAIN_CAP_MS)
    t.unref() // 别让这个计时器自己把进程吊住
  })

  Promise.race([Promise.allSettled([...pending]), cap]).then(() => {
    for (const c of inflight.values()) c.abort()
    log('退出')
    process.exit(0)
  })
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`收到 ${sig}，中止在飞请求`)
    for (const c of inflight.values()) c.abort()
    process.exit(130)
  })
}

process.on('uncaughtException', (e) => log(`未捕获异常：${e && e.stack ? e.stack : e}`))
process.on('unhandledRejection', (e) => log(`未处理的 Promise 拒绝：${e}`))

log(`就绪。仓库根 ${ROOT}，${TOOLS.length} 个工具：${TOOLS.map((t) => t.name).join(', ')}`)
