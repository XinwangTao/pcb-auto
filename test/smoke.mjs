#!/usr/bin/env node
/**
 * pcb-auto · 冒烟测试
 *
 * 只测「契约」，不测「业务」。业务由 verify-delivery.ps1 和 fabcheck 自己测。
 * 这里要证明的是：**三层外壳都能真的把参数送到同一个实现上，并且退出码语义一致。**
 *
 * 全程零依赖、零网络、不写盘、不碰 EDA 进程。可以在 CI 上跑。
 *
 *   node test/smoke.mjs
 *
 * 退出码 0 = 全过；1 = 有断言失败。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(join(HERE, '..'))
const NODE = process.execPath

const read = (p) => readFileSync(p, 'utf8')

let pass = 0
const failures = []

const check = (name, fn) => {
  try {
    const detail = fn()
    pass += 1
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ''}`)
  } catch (e) {
    failures.push({ name, message: e.message })
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}`)
    console.log(`        ${e.message.split('\n').join('\n        ')}`)
  }
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

/** 跑一条命令，绝不抛；返回 {code, stdout, stderr}。 */
const run = (args, opts = {}) => {
  const r = spawnSync(NODE, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: opts.timeout ?? 120_000,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1', ...(opts.env ?? {}) },
  })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** 单行 JSON 输入 → 多行 JSON-RPC 输出，逐行解析。 */
const mcpSession = (messages) => {
  const input = messages.map((m) => JSON.stringify(m)).join('\n') + '\n'
  const r = spawnSync(NODE, [join(ROOT, 'mcp', 'server.mjs')], {
    cwd: ROOT, input, encoding: 'utf8', timeout: 60_000, windowsHide: true,
    env: { ...process.env, NO_COLOR: '1' },
  })
  const lines = (r.stdout ?? '').split('\n').filter((l) => l.trim())
  return {
    code: r.status,
    stderr: r.stderr ?? '',
    lines,
    replies: lines.map((l, i) => {
      try { return JSON.parse(l) } catch { throw new Error(`第 ${i + 1} 行不是合法 JSON：${l.slice(0, 200)}`) }
    }),
  }
}

console.log('\n\x1b[1m1 · 文件结构\x1b[0m')

for (const rel of [
  'core/ops.mjs', 'cli/pcb.mjs', 'mcp/server.mjs', 'plugin/index.js',
  'plugin/package.json', 'plugin/cordis.patch.yml',
  'plugin/locale/en.json', 'plugin/locale/zh.json', 'plugin/icon.svg',
  'plugin/docs/DETAIL.md', 'package.json', 'LICENSE', 'README.md', 'llms.txt',
  'AGENTS.md', 'docs/SUPPORT.md', 'docs/WHY.md', 'install/install.mjs',
  '.mcp.json', '.claude-plugin/plugin.json', 'CITATION.cff',
]) {
  check(`存在 ${rel}`, () => {
    const p = join(ROOT, rel)
    assert(existsSync(p), `缺失：${p}`)
    const n = statSync(p).size
    assert(n > 0, `空文件：${p}`)
    return `${n} B`
  })
}

console.log('\n\x1b[1m2 · 语法闸门\x1b[0m')

for (const rel of ['core/ops.mjs', 'cli/pcb.mjs', 'mcp/server.mjs', 'plugin/index.js', 'install/install.mjs', 'test/smoke.mjs']) {
  check(`node --check ${rel}`, () => {
    const r = run(['--check', join(ROOT, rel)])
    assert(r.code === 0, `exit ${r.code}\n${r.stderr}`)
  })
}

console.log('\n\x1b[1m3 · JSON / YAML 清单可解析\x1b[0m')

for (const rel of ['package.json', 'plugin/package.json', 'plugin/locale/en.json', 'plugin/locale/zh.json', '.mcp.json', '.claude-plugin/plugin.json']) {
  check(`JSON 可解析 ${rel}`, () => {
    const j = JSON.parse(read(join(ROOT, rel)))
    assert(j && typeof j === 'object', '不是对象')
    return `${Object.keys(j).length} 个顶层键`
  })
}

console.log('\n\x1b[1m4 · CLI 契约\x1b[0m')

check('pcb list 退出 0 且列出 5 个操作', () => {
  const r = run([join(ROOT, 'cli', 'pcb.mjs'), 'list'])
  assert(r.code === 0, `exit ${r.code}\n${r.stderr}`)
  for (const op of ['idea-to-design', 'build', 'fabcheck', 'census', 'verify']) {
    assert(r.stdout.includes(op), `输出里没有 ${op}`)
  }
  return '5 个操作'
})

check('pcb list 的 stdout 是合法 JSON', () => {
  const r = run([join(ROOT, 'cli', 'pcb.mjs'), 'list'])
  const j = JSON.parse(r.stdout)
  const ops = Array.isArray(j) ? j : (j.ops ?? j.operations)
  assert(Array.isArray(ops), '没找到操作数组')
  assert(ops.length === 5, `期望 5 个，得到 ${ops.length}`)
  return `${ops.length} 个`
})

check('缺参数 → 退出码 2（调用错误，不是判定）', () => {
  const r = run([join(ROOT, 'cli', 'pcb.mjs'), 'fabcheck'])
  assert(r.code === 2, `期望 2，得到 ${r.code}\n${r.stderr}`)
  return 'exit 2'
})

check('不存在的目录 → 退出码 2', () => {
  const r = run([join(ROOT, 'cli', 'pcb.mjs'), 'fabcheck', '__definitely_not_here__'])
  assert(r.code === 2, `期望 2，得到 ${r.code}`)
})

check('未知子命令 → 非 0', () => {
  const r = run([join(ROOT, 'cli', 'pcb.mjs'), '__nope__'])
  assert(r.code !== 0, `期望非 0，得到 ${r.code}`)
})

console.log('\n\x1b[1m5 · MCP 协议契约\x1b[0m')

const init = mcpSession([
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } },
])

check('initialize 有 protocolVersion / serverInfo / capabilities', () => {
  const r = init.replies[0]
  assert(r?.result, `没有 result：${init.lines[0]?.slice(0, 300)}`)
  assert(typeof r.result.protocolVersion === 'string', '缺 protocolVersion')
  assert(r.result.serverInfo?.name === 'pcb-auto', `serverInfo.name = ${r.result.serverInfo?.name}`)
  assert(r.result.capabilities?.tools, '缺 capabilities.tools')
  return `proto ${r.result.protocolVersion}`
})

check('stdout 只有合法 JSON-RPC（日志不污染 stdout）', () => {
  assert(init.lines.length === init.replies.length, 'stdout 里有非 JSON 行')
  for (const r of init.replies) assert(r.jsonrpc === '2.0', 'JSON-RPC 缺 jsonrpc 2.0')
  return `${init.lines.length} 行全部合法`
})

const full = mcpSession([
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  { jsonrpc: '2.0', id: 3, method: 'ping' },
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'pcb_fabcheck', arguments: { dir: 'out/d1' } } },
  { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: '__nope__', arguments: {} } },
  { jsonrpc: '2.0', id: 6, method: '__nope_method__' },
])

const byId = Object.fromEntries(full.replies.filter((r) => r.id != null).map((r) => [r.id, r]))

check('tools/list 返回 5 个工具且名字带 pcb_ 前缀', () => {
  const tools = byId[2]?.result?.tools
  assert(Array.isArray(tools), '没有 tools 数组')
  assert(tools.length === 5, `期望 5 个，得到 ${tools.length}`)
  for (const t of tools) assert(t.name.startsWith('pcb_'), `工具名没有 pcb_ 前缀：${t.name}`)
  return tools.map((t) => t.name).join(' ')
})

check('每个工具都有 inputSchema 且是 object', () => {
  for (const t of byId[2].result.tools) {
    assert(t.inputSchema?.type === 'object', `${t.name} 的 inputSchema 不是 object`)
    assert(typeof t.description === 'string' && t.description.length > 20, `${t.name} 的 description 太短`)
  }
})

check('只读工具带 readOnlyHint，build 不带', () => {
  const tools = Object.fromEntries(byId[2].result.tools.map((t) => [t.name, t]))
  for (const n of ['pcb_fabcheck', 'pcb_census', 'pcb_verify']) {
    assert(tools[n].annotations?.readOnlyHint === true, `${n} 应该是只读`)
  }
  assert(tools.pcb_build.annotations?.readOnlyHint !== true, 'pcb_build 不该标只读')
})

check('ping 返回空对象', () => {
  const r = byId[3]
  assert(r?.result, 'ping 没有 result')
  assert(Object.keys(r.result).length === 0, `ping 应该返回 {}，得到 ${JSON.stringify(r.result)}`)
})

/**
 * `out/` 是 gitignore 的（产物几百 MB），所以**新克隆的仓库里没有 `out/d1`**。
 * 这条测试因此必须自适应：
 *   - 有 `out/d1`（开发者本机）→ 验证「判定为否」的完整路径
 *   - 没有（新克隆 / CI）    → 退化成验证「调用错误」路径，并明确标 SKIP 原因
 *
 * 不这么做的后果：这条测试在 CI 上必红，然后有人会把它删掉 —— 那才是真正的失败。
 */
const D1 = join(ROOT, 'out', 'd1')
const hasD1 = existsSync(D1)

if (hasD1) {
  check('tools/call pcb_fabcheck 返回退出码 1 且 isError=false', () => {
    const r = byId[4]
    assert(r?.result, `没有 result：${r ? JSON.stringify(r).slice(0, 400) : '未收到回复'}`)
    // 「不可下单」是一个**结论**，不是错误 —— 这是整个契约的核心。
    assert(r.result.isError === false, `isError 应该是 false，得到 ${r.result.isError}`)
    const sc = r.result.structuredContent
    assert(sc, '缺 structuredContent')
    assert(sc.exitCode === 1, `期望 exitCode 1，得到 ${sc.exitCode}`)
    assert(sc.orderable === false, `期望 orderable false，得到 ${sc.orderable}`)
    assert(Array.isArray(r.result.content) && r.result.content[0]?.type === 'text', '缺 content[0].text')
    return `exitCode 1 / orderable false / ${sc.blockers?.length ?? '?'} 阻断`
  })
} else {
  console.log('  \x1b[33mSKIP\x1b[0m  tools/call pcb_fabcheck 的「判定为否」路径'
    + '  \x1b[90m（没有 out/d1 —— 新克隆里 out/ 是 gitignore 的）\x1b[0m')
  console.log('        \x1b[90m想看完整路径：先跑一次 build 生成产物，或从 Releases 下载样本\x1b[0m')

  check('tools/call 对不存在的目录返回退出码 2 且不崩', () => {
    const s = mcpSession([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'pcb_fabcheck', arguments: { dir: '__definitely_not_here__' } } },
    ])
    const r = s.replies.find((x) => x.id === 2)
    assert(r?.result, `没有 result：${r ? JSON.stringify(r).slice(0, 300) : '未收到回复'}`)
    const sc = r.result.structuredContent
    assert(sc?.exitCode === 2, `期望 exitCode 2，得到 ${sc?.exitCode}`)
    // 参数错误才是 isError:true 的唯一合法来源。
    assert(r.result.isError === true, `参数错误时 isError 应为 true，得到 ${r.result.isError}`)
    return 'exitCode 2 / isError true'
  })
}

check('未知工具 → -32602', () => {
  const e = byId[5]?.error
  assert(e, '没有 error')
  assert(e.code === -32602, `期望 -32602，得到 ${e.code}`)
})

check('未知方法 → -32601', () => {
  const e = byId[6]?.error
  assert(e, '没有 error')
  assert(e.code === -32601, `期望 -32601，得到 ${e.code}`)
})

console.log('\n\x1b[1m6 · 插件薄壳不复制逻辑\x1b[0m')

check('plugin/index.js 动态 import core/ops.mjs', () => {
  const src = read(join(ROOT, 'plugin', 'index.js'))
  assert(/import\s*\(\s*pathToFileURL/.test(src), '没有动态 import')
  assert(src.includes("'core', 'ops.mjs'"), '没有拼 core/ops.mjs 路径')
  // 反向断言：如果它自己实现了 dispatch，就说明逻辑被复制了。
  assert(!/async function dispatch/.test(src), '插件自己实现了 dispatch —— 逻辑被复制了')
  assert(!/function ideaToDesign/.test(src), '插件自己实现了 ideaToDesign —— 逻辑被复制了')
  // 根定位必须来自可测的零依赖模块，不能内联 —— 内联就只能在没有测试的环境里跑。
  assert(src.includes("from './locate-root.mjs'"), '没有从 locate-root.mjs 引入根定位')
  assert(!/function locateRoot/.test(src), 'locateRoot 被内联了 —— 它无法被单独测试')
})

check('locateRoot 在不给 config 时也能找到仓库根', () => {
  // 注意：import() 只吃 file:// URL。Windows 绝对路径必须先过 pathToFileURL，
  // 否则报 "Received protocol 'd:'" —— 这个坑值得留一条断言防复发。
  const url = pathToFileURL(join(ROOT, 'plugin', 'locate-root.mjs')).href
  const out = run(['-e', `
    import(${JSON.stringify(url)})
      .then(m => { console.log(JSON.stringify(m.locateRoot({}))) })
      .catch(e => { console.error(e.message); process.exit(1) })
  `])
  assert(out.code === 0, `退出 ${out.code}\n${out.stderr}`)
  const r = JSON.parse(out.stdout.trim().split('\n').pop())
  assert(
    r.root.toLowerCase().replace(/\\/g, '/').endsWith('pcb-auto'),
    `root 不对：${r.root}`,
  )
  return r.how
})

check('locateRoot 在三条路径全失败时抛出可操作的错误', () => {
  const url = pathToFileURL(join(ROOT, 'plugin', 'locate-root.mjs')).href
  // 三个条件同时成立才会抛：config.root 不存在、PCB_AUTO_ROOT 清空、selfUrl 不在仓库内。
  const out = run(['-e', `
    import(${JSON.stringify(url)}).then(async (m) => {
      const os = await import('node:os')
      const path = await import('node:path')
      const { pathToFileURL } = await import('node:url')
      const elsewhere = pathToFileURL(path.join(os.tmpdir(), 'nowhere', 'locate-root.mjs')).href
      delete process.env.PCB_AUTO_ROOT
      try {
        m.locateRoot({ root: 'C:/definitely/not/here' }, elsewhere)
        console.log('NO_THROW')
      } catch (e) { console.log(e.message) }
    }).catch(e => { console.error(e.message); process.exit(1) })
  `])
  assert(out.code === 0, `退出 ${out.code}\n${out.stderr}`)
  assert(!out.stdout.includes('NO_THROW'), '应该抛错但没有抛')
  assert(out.stdout.includes('找不到仓库根'), '错误信息没说明问题')
  assert(out.stdout.includes('PCB_AUTO_ROOT'), '错误信息没给出可操作的解决方式')
  assert(out.stdout.includes('已尝试'), '错误信息没列出尝试过的路径')
  return '含 3 种解决方式 + 尝试记录'
})

check('locateRoot 对坏的 config.root 会回退而不是直接失败', () => {
  // 这是设计意图：路径配错不该让整个插件装不上，能自动探测就继续。
  const url = pathToFileURL(join(ROOT, 'plugin', 'locate-root.mjs')).href
  const out = run(['-e', `
    import(${JSON.stringify(url)})
      .then(m => { console.log(JSON.stringify(m.locateRoot({ root: 'C:/definitely/not/here' }))) })
      .catch(e => { console.error(e.message); process.exit(1) })
  `])
  assert(out.code === 0, `退出 ${out.code}\n${out.stderr}`)
  const r = JSON.parse(out.stdout.trim().split('\n').pop())
  assert(r.how === '包位置自动探测', `期望回退到自动探测，得到 ${r.how}`)
  return r.how
})

console.log('\n\x1b[1m7 · 安装器覆盖全部平台\x1b[0m')

check('install.mjs --list 列出 ≥19 个客户端', () => {
  const r = run([join(ROOT, 'install', 'install.mjs'), '--list'])
  assert(r.code === 0, `exit ${r.code}`)
  const m = r.stdout.match(/共\s*(\d+)\s*个/)
  assert(m, '没找到计数')
  const n = Number(m[1])
  assert(n >= 19, `只列了 ${n} 个`)
  for (const k of ['claude-code', 'cursor', 'windsurf', 'vscode', 'codex-cli', 'gemini-cli', 'any-shell-agent', 'dsh']) {
    assert(r.stdout.includes(k), `缺 ${k}`)
  }
  return `${n} 个`
})

check('每个平台都能 --print 出非空片段', () => {
  const r = run([join(ROOT, 'install', 'install.mjs'), '--list'])
  const ids = [...r.stdout.matchAll(/^\s{2}([a-z0-9-]+)\s{2}/gm)].map((m) => m[1])
  assert(ids.length >= 19, `只解析到 ${ids.length} 个 id`)
  for (const id of ids) {
    const p = run([join(ROOT, 'install', 'install.mjs'), '--print', id])
    assert(p.code === 0, `${id}: exit ${p.code}`)
    assert(p.stdout.trim().length > 40, `${id}: 输出太短`)
  }
  return `${ids.length} 个全部可打印`
})

console.log('\n────────────────────────────────────────────────────────────')
if (failures.length === 0) {
  console.log(`  \x1b[32mSMOKE=PASS\x1b[0m   ${pass} 项全过`)
  console.log('────────────────────────────────────────────────────────────\n')
  process.exit(0)
} else {
  console.log(`  \x1b[31mSMOKE=FAIL\x1b[0m   ${pass} 过 / ${failures.length} 失败`)
  for (const f of failures) console.log(`    ✗ ${f.name}`)
  console.log('────────────────────────────────────────────────────────────\n')
  process.exit(1)
}
