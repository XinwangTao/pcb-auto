#!/usr/bin/env node
/**
 * pcb-auto · 冒烟测试
 *
 * 只测「契约」，不测「业务」。业务由 verify-delivery.ps1 和 fabcheck 自己测。
 * 这里要证明的是：**三层外壳都能真的把参数送到同一个实现上，并且退出码语义一致。**
 *
 * 全程零依赖、零网络、不碰 EDA 进程。可以在 CI 上跑。
 *
 * 会写盘的只有一处：第 8 组要验 `census` 真的能扫一遍，而它会重写
 * `out/_probe/fab-census.json`（那份文件是随仓库发布的证据）。测试会在跑前把它
 * 原样存下来、跑后原样写回，所以对外**净变化为零**。不这么做的话，
 * 每跑一次测试就把发布出去的测量结果覆盖掉 —— 而测完没人会注意到。
 *
 *   node test/smoke.mjs
 *
 * 退出码 0 = 全过；1 = 有断言失败。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  'docs/REVERSE-NOTES.md', 'api/_index.json', 'api/classes.csv', 'api/methods.csv',
  '.mcp.json', '.claude-plugin/plugin.json', 'CITATION.cff',
  // 插件契约测试和它的桩：删掉任何一件，DSH 那一侧就没人验了。
  'test/plugin-harness.mjs', 'test/dsh-stubs/resolver.mjs',
  'test/dsh-stubs/dsh-tools.mjs', 'test/dsh-stubs/schemastery.mjs',
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

for (const rel of ['core/ops.mjs', 'cli/pcb.mjs', 'mcp/server.mjs', 'plugin/index.js', 'plugin/locate-root.mjs', 'install/install.mjs', 'test/smoke.mjs', 'test/plugin-harness.mjs', 'test/dsh-stubs/resolver.mjs']) {
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
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'pcb_fabcheck', arguments: { dir: 'examples/d1' } } },
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
 * 「判定为否」这条路径以前在 CI 上是**测不到的**。
 *
 * `out/` 是 gitignore 的（产物几百 MB），新克隆里没有 `out/d1`，所以这条测试
 * 只能退化成 SKIP，外加再测一遍「调用错误」路径。结果是：CI 永远绿，
 * 而 MCP 适配层最核心的那条契约 —— 「不可下单是一个结论，不是错误
 * （exitCode 1 + isError false）」——**从来没有在 CI 上被验证过**。
 *
 * 修法不是把测试改成自适应，是把样本放进仓库：`examples/d1/` 是一份真实的
 * 6 文件产物，`fabcheck` 对它给出 exit 1 + 恰好一条已知误判的阻断。
 * 于是这条断言无条件成立，CI 上也会真的跑。
 *
 * 顺带的好处：任何人在不装 EDA 的机器上，`node cli/pcb.mjs fabcheck examples/d1`
 * 就能自己确认这个判据不是恒真的。
 */
const D1 = join(ROOT, 'examples', 'd1')

check('tools/call pcb_fabcheck 返回退出码 1 且 isError=false', () => {
  assert(existsSync(D1), `样本目录不存在：${D1}。它必须随仓库发布，否则这条断言又会退化成 SKIP。`)
  const r = byId[4]
  assert(r?.result, `没有 result：${r ? JSON.stringify(r).slice(0, 400) : '未收到回复'}`)
  // 「不可下单」是一个**结论**，不是错误 —— 这是整个契约的核心。
  assert(r.result.isError === false, `isError 应该是 false，得到 ${r.result.isError}`)
  const sc = r.result.structuredContent
  assert(sc, '缺 structuredContent')
  assert(sc.exitCode === 1, `期望 exitCode 1，得到 ${sc.exitCode}`)
  assert(sc.orderable === false, `期望 orderable false，得到 ${sc.orderable}`)
  assert(Array.isArray(r.result.content) && r.result.content[0]?.type === 'text', '缺 content[0].text')
  /*
   * 注意 `sc.blockers` 是**字符串**（按行拼好给人读的），不是数组。
   * 曾经在这里写过 `${sc.blockers?.length} 阻断`，打出「37 阻断」——
   * 那是 37 个**字符**。条数在 `blockerCount` 里。这个错误形状
   * 和 fabcheck 的 `"id"` 出现在四个数组里被正则数成 19 倍是同一类：
   * 把一个结构性事实当成一个数量。
   */
  assert(sc.blockerCount === 1, `样本 d1 期望恰好 1 条阻断，得到 ${sc.blockerCount}（${sc.blockers}）`)
  // 锚在稳定的 id 上，不锚散文 —— d1 那条阻断是已知的阈值误判，换了样本或改了阈值就该红。
  assert(
    Array.isArray(sc.blockerIds) && sc.blockerIds.includes('gerber.copper.thin'),
    `期望阻断 id 里含 gerber.copper.thin，得到 ${JSON.stringify(sc.blockerIds)}`,
  )
  return `exitCode 1 / orderable false / ${sc.blockerCount} 阻断 ${sc.blockerIds.join(',')}`
})

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

  // 不要断言目录**名字**。全新克隆的目录可以叫任何名字（CI 里通常是 pcb-auto-xxxx），
  // 写死名字的断言在开发者本机永远绿、在别人的机器上永远红 —— 这是最糟的一种测试。
  // 真正要验的是「返回的根确实是一个能用的 pcb-auto 仓库」。
  assert(r.how === '包位置自动探测', `期望自动探测，得到 ${r.how}`)
  assert(
    existsSync(join(r.root, 'core', 'ops.mjs')),
    `root 下没有 core/ops.mjs：${r.root}`,
  )
  assert(
    existsSync(join(r.root, 'cli', 'pcb.mjs')),
    `root 下没有 cli/pcb.mjs：${r.root}`,
  )
  // 而且必须就是本测试所在的仓库，不能是别的地方。
  assert(
    r.root.toLowerCase().replace(/\\/g, '/') === ROOT.toLowerCase().replace(/\\/g, '/'),
    `root 不是本仓库：${r.root} vs ${ROOT}`,
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

console.log('\n\x1b[1m8 · 量具不许编造\x1b[0m')

/**
 * 这一组的由来：把仓库推到 GitHub 之后，在全新克隆里跑 `census`，
 * 它报出「56 个目录 / 53 可下单」，而那个克隆里一个产物目录都没有。
 *
 * 两个原因同时存在：
 *   1. fab-census.py 把开发者绝对路径写死在 ROOT 里 → 它去量了另一台目录；
 *   2. ops.mjs 不看退出码就读磁盘上的旧报告，还把 at 写成「现在」。
 *
 * 「读不到输入时保持沉默，并且把上次的答案拿出来」是最危险的一类错：
 * 它不报错，它给一个看起来完全正常的数字。所以钉在这里。
 */
const PROBE = join(ROOT, 'out', '_probe')

for (const rel of ['fab-census.py', 'idea-fabchain.py', 'make-dossier.py', 'artifact-consistency.py']) {
  check(`量具 ${rel} 不硬编码开发者路径`, () => {
    const p = join(PROBE, rel)
    if (!existsSync(p)) return '不存在（跳过）'
    const src = read(p)
    assert(!/^\s*ROOT\s*=\s*r?"[A-Za-z]:\\/m.test(src), '仍然把 ROOT 写成绝对路径常量')
    assert(!/陶鑫旺/.test(src), '仍然含开发者用户名')
    assert(!/^\s*NODE\s*=\s*r?"[A-Za-z]:\\/m.test(src), '仍然把 NODE 写成绝对路径常量')
    assert(/PCB_AUTO_ROOT/.test(src) || /__file__/.test(src), '没有可移植的根定位')
  })
}

/*
 * 上面那 4 条只查 4 个文件名。
 *
 * 一次全新克隆的独立审计发现：**65 个文件**带着开发者的绝对路径，
 * 而这里当时报的是 76/76 全绿。这不是「漏了一部分」，是闸门的形状错了：
 * 它查的是「我记得被我改过的那几个文件」，不是「全库还有没有」。
 *
 * 一个只查 4 个文件的扫描器比没有扫描器更危险 —— 没有扫描器时你至少知道自己没查过；
 * 有了它，你会以为查过了。
 *
 * 所以闸门改成由 `test/dev-path-scan.mjs` 提供，它扫全部被 git 跟踪的文本文件，
 * 并且是**两级**的：
 *
 *   功能级  一个照文档去用的人真的会执行到的文件。这里断言必须为 0。
 *   历史级  历史补丁记录 / 一次性探针 / 渲染产物。逐条点名豁免，允许存在。
 *
 * 下面第二条断言是这套设计的关键：每条豁免都必须在当前仓库里真的命中至少一处。
 * 豁免因此不会变成「关掉检查」——哪天那些文件被清干净，豁免就命不中，这里会红，
 * 逼着人把豁免删掉。这样豁免表不会自己腐烂。
 */
{
  let mod = null
  let scanErr = null
  try {
    mod = await import(pathToFileURL(join(HERE, 'dev-path-scan.mjs')).href)
  } catch (e) {
    scanErr = e
  }

  check('全库没有功能级开发者路径', () => {
    assert(!scanErr, `扫描器本身加载失败：${scanErr && scanErr.message}`)
    let hits
    try {
      hits = mod.scan(ROOT)
    } catch (e) {
      // 不是 git 仓库（例如从 tar 包里跑）时无法枚举「被跟踪的文件」。
      // 这里必须明说，不能静默通过 —— 静默通过正是当初那个假绿闸门的形状。
      if (/not a git repository|ENOENT.*git/i.test(e.message)) {
        return 'SKIP 不是 git 仓库，无法枚举被跟踪文件（这条只在 git 检出上有效）'
      }
      throw e
    }
    const s = mod.summary(hits)
    if (s.functional > 0) {
      const top = hits
        .filter((h) => h.severity === 'functional')
        .slice(0, 8)
        .map((h) => `${h.file}:${h.line}  ${h.rule}  ${h.sample}`)
      throw new Error(
        `功能级 ${s.functional} 处，分布在 ${s.functionalFiles} 个文件里。`
        + `\n前几处：\n  ${top.join('\n  ')}`
        + '\n\n这些文件是「照文档去用的人真的会执行到」的。'
        + '\n改成 scripts/tool-paths.ps1 的 Resolve-* 解析，别再加硬编码路径。',
      )
    }
    return `功能级 0 处；历史级 ${s.historical} 处 / ${s.historicalFiles} 个文件（已点名豁免）`
  })

  check('开发者路径豁免表没有失效条目', () => {
    assert(!scanErr, `扫描器本身加载失败：${scanErr && scanErr.message}`)
    let hits
    try {
      hits = mod.scan(ROOT)
    } catch (e) {
      if (/not a git repository|ENOENT.*git/i.test(e.message)) {
        return 'SKIP 不是 git 仓库'
      }
      throw e
    }
    const dead = mod.summary(hits).deadExemptions
    assert(
      dead.length === 0,
      `这 ${dead.length} 条豁免已经命不中任何东西了：${dead.join(', ')}`
      + '\n说明对应文件已经不脏了。豁免留着不是「多一层保险」，是让人觉得还有债。'
      + '\n去 test/dev-path-scan.mjs 的 EXEMPT 里删掉它们。',
    )
    return `${mod.exemptionIds().length} 条豁免全部命中`
  })
}

/*
 * 这一条来自一次真实的 CI 失败，值得单独钉住：
 *
 *     UnicodeEncodeError: 'charmap' codec can't encode characters in position 11-13
 *
 * GitHub 的 windows-latest 是 cp1252。量具里 `print("  fabcheck 普查：…")`
 * 这一行直接抛异常，脚本返回非 0 —— 于是整个 census 在 CI 上永远失败。
 * 本机是中文 Windows（cp936，能编码中文），所以本地永远绿。
 *
 * 结论：**一行中文摘要能让整个量具在别人的机器上不可用。**
 */
for (const rel of ['fab-census.py', 'idea-fabchain.py', 'make-dossier.py', 'artifact-consistency.py']) {
  check(`量具 ${rel} 不依赖控制台代码页`, () => {
    const p = join(PROBE, rel)
    if (!existsSync(p)) return '不存在（跳过）'
    const src = read(p)
    assert(/reconfigure\(\s*encoding\s*=\s*["']utf-8["']/.test(src),
      '没有把 stdout/stderr 强制成 UTF-8 —— 在 cp1252 或任何非中文代码页上会 UnicodeEncodeError')
    // 不能写死成 `import sys`：这几个脚本用的是合并写法 `import io, os, ..., sys`。
    assert(/import[^\n]*\bsys\b|^import sys$/m.test(src), '没有导入 sys，无法 reconfigure')
  })
}

check('量具报告是原子写（崩溃不留半截 JSON）', () => {
  const src = read(join(PROBE, 'fab-census.py'))
  assert(/os\.replace\(_tmp, OUT\)|os\.rename\(_tmp/.test(src),
    '直接覆盖写：中途崩溃会留下半截 JSON，而下游会把残缺当完整')
})

/*
 * `py_compile` 只查语法。NameError 要到运行时才炸，而它在 CI 上的表现是
 * 「量具返回非 0」—— 真正的原因埋在 stderr 里，很容易被当成环境问题糊过去。
 * 今晚两次 `shutil` 未导入都是这么来的，所以加一道静态闸门。
 */
check('量具没有「模块级用了却从未导入」的名字', () => {
  const script = join(PROBE, 'undefined-names.py')
  if (!existsSync(script)) return '缺 undefined-names.py（跳过）'
  const targets = readdirSync(PROBE).filter((f) => f.endsWith('.py')).map((f) => join(PROBE, f))
  // ubuntu 上通常只有 python3；Windows 上通常只有 python。两个都试。
  const candidates = [process.env.PCB_AUTO_PYTHON, 'python', 'python3'].filter(Boolean)
  let tried = null
  for (const py of candidates) {
    const r = spawnSync(py, [script, ...targets], { encoding: 'utf8', windowsHide: true, timeout: 120_000 })
    if (r.error) { tried = `${py}: ${r.error.code}`; continue }
    assert(r.status === 0, `${r.stdout || ''}${r.stderr || ''}`.trim().slice(0, 800))
    return `${targets.length} 个脚本（${py}）`
  }
  return `跳过：没有可用的 Python（${tried}）`
})

/**
 * 在本仓库上真跑一次 census，**跑完把报告文件原样写回**。
 *
 * 为什么要还原：`out/_probe/fab-census.json` 是随仓库发布的一份度量证据。
 * 在一个没有产物目录的克隆里跑一次 census，它会被改写成「0 个目录」——
 * 一份测试不该顺带销毁它要检验的对象。而且这种事没人会注意到。
 */
const censusOnThisRepo = () => {
  const report = join(PROBE, 'fab-census.json')
  const before = existsSync(report) ? readFileSync(report) : null
  try {
    const r = run([join(ROOT, 'cli', 'pcb.mjs'), 'census'], { timeout: 300_000 })
    if (!r.stdout.trim()) throw new Error(`没有输出；stderr=${r.stderr.slice(0, 300)}`)
    let j
    try { j = JSON.parse(r.stdout.trim()) } catch { throw new Error(`不是 JSON：${r.stdout.slice(0, 200)}`) }
    return { j, code: r.code }
  } finally {
    try {
      if (before !== null) writeFileSync(report, before)
      else if (existsSync(report)) rmSync(report, { force: true })
    } catch { /* 还原失败不该掩盖真正的断言结果 */ }
  }
}

check('census 输出带 source 字段，能分辨 live / snapshot', () => {
  const { j } = censusOnThisRepo()

  // 失败时也要有明确的 source，不能让调用方去猜字段在不在。
  const allowed = ['live', 'snapshot', 'none']
  assert(allowed.includes(j.source),
    `source=${j.source} 不在 ${allowed.join('/')} 里；原始输出：${JSON.stringify(j).slice(0, 400)}`)

  // source=none 意味着量具根本没跑成。这必须带着原始错误信息报出来 ——
  // 不然下一个人只能靠猜（这一条就是这么来的：CI 上只看到「source 取值非法」）。
  if (j.source === 'none') {
    assert(typeof j.reason === 'string' && j.reason, 'source=none 却没给 reason')
    throw new Error(`量具没跑成：${j.reason}\n原始输出：${(j.raw || '（空）').slice(0, 600)}`)
  }

  // 这是核心：如果它没真扫一遍，就不能把时间戳写成「刚刚」。
  if (j.source === 'snapshot') {
    assert(typeof j.sourceNote === 'string' && j.sourceNote.length > 10, 'snapshot 却没解释为什么')
  }
  // 0 个目录不是「全部通过」。
  if (j.dirs === 0) {
    assert(typeof j.emptyNote === 'string', 'dirs=0 却没给 emptyNote —— 会被读成 0/0 全过')
    assert(j.fabOk === 0, `dirs=0 却报 fabOk=${j.fabOk}`)
  }
  // at 必须是「测于何时」，所以得是可解析的时间，且不能在未来。
  const t = Date.parse(j.at)
  assert(Number.isFinite(t), `at 不是时间：${j.at}`)
  assert(t <= Date.now() + 60_000, `at 在未来：${j.at}`)
  return `source=${j.source} dirs=${j.dirs} fabOk=${j.fabOk}`
})

check('census 退出码与 ok 一致（ok=true ⇔ exitCode=0）', () => {
  const { j, code } = censusOnThisRepo()
  assert((j.ok === true) === (j.exitCode === 0), `ok=${j.ok} 但 exitCode=${j.exitCode}`)
  assert(code === (j.ok ? 0 : j.exitCode), `进程退出码 ${code} 与输出里的 ${j.exitCode} 不一致`)
})

check('census 跑完之后报告文件原样还原（测试不销毁证据）', () => {
  // 上两条已经会写盘又还原。这里再独立确认一次净变化为零。
  const report = join(PROBE, 'fab-census.json')
  if (!existsSync(report)) return '本仓库没有该文件（新克隆里已被 gitignore 之外的路径保护，跳过）'
  const before = readFileSync(report)
  censusOnThisRepo()
  const after = readFileSync(report)
  assert(before.equals(after), '报告文件被测试改动了 —— 发布出去的度量证据被覆盖')
  return `${after.length} B 未变`
})

/** 造一个最小仓库结构：只有 out/_probe/，可以把任意量具脚本塞进去。 */
const fakeRoot = (scriptBody, staleReport) => {
  const tmp = mkdtempSync(join(tmpdir(), 'pcb-auto-probe-'))
  mkdirSync(join(tmp, 'out', '_probe'), { recursive: true })
  if (scriptBody !== null) {
    writeFileSync(join(tmp, 'out', '_probe', 'fab-census.py'), scriptBody, 'utf8')
  }
  if (staleReport !== undefined) {
    writeFileSync(join(tmp, 'out', '_probe', 'fab-census.json'), JSON.stringify(staleReport), 'utf8')
  }
  return tmp
}

const STALE = {
  all: { n: 999, fab_ok: 999, fab_blocked: 0, fab_error: 0 },
  settle_s: 0, blocker_ids: {}, self_ok_true: { n: 999, fab_ok: 999 },
}

/** 在假仓库上跑 core 的 census，返回它的输出对象。 */
const censusAt = (root) => {
  const r = run(['-e', `
    const { census } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'core', 'ops.mjs')).href)})
    console.log(JSON.stringify(await census({}, { root: ${JSON.stringify(root)} })))
  `], { timeout: 90_000 })
  assert(r.code === 0, `node exit ${r.code}: ${r.stderr.slice(0, 300)}`)
  return JSON.parse(r.stdout.trim().split('\n').pop())
}

check('量具不存在 → census 明确失败，不去读旧报告', () => {
  const tmp = fakeRoot(null, STALE)
  try {
    const j = censusAt(tmp)
    assert(j.ok === false, `返回 ok=true（dirs=${j.dirs}）—— 读了不该读的旧报告`)
    assert(j.dirs === 0, `报出 ${j.dirs} 个目录`)
    assert(j.exitCode !== 0, `exitCode=${j.exitCode}，期望非 0`)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

// 这条才是原来那个真实 bug 的形状：量具在、但它跑失败了，而磁盘上躺着一份旧报告。
// 如果实现不看退出码就去读报告文件，它会把 999 当成这次的结果报出来。
check('量具跑失败 + 磁盘有旧报告 → 不许拿旧报告当结果', () => {
  const tmp = fakeRoot('import sys\nsys.exit(1)\n', STALE)
  try {
    const j = censusAt(tmp)
    assert(j.ok === false, `量具失败了却返回 ok=true —— 它读了旧报告（dirs=${j.dirs}）`)
    assert(j.dirs !== 999, '把旧报告里的 999 当成这次的结果报了出来')
    assert(j.exitCode !== 0, `exitCode=${j.exitCode}，期望非 0`)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

// 量具成功但**没有写出新报告**，而且本机一句产物都没有。
//
// 这里曾经只断言 `source === 'snapshot'`。那个断言把**两个问题**压成了一句话：
//   Q1  headline 是不是本机语料的测量？
//   Q2  报告文件有没有被这次运行重写？
// 本机 0 个目录时，`dirs: 0` 是当场数出来的（Q1=live），文件确实没被重写（Q2=false）。
// 只报一个值，无论报哪个都在骗人 —— 报 `dirs: 999` 更糟，那会让一个空克隆
// 以为自己有 999 个目录。
//
// 现在 `source` 只回答 Q1，`refreshed` 单独回答 Q2，两条都钉住。
check('量具没写出新报告 + 本机无产物 → 报 0，快照数字单列，且不冒充本机数据', () => {
  const tmp = fakeRoot('import sys\nsys.exit(0)\n', STALE)
  try {
    const before = statSync(join(tmp, 'out', '_probe', 'fab-census.json')).mtimeMs
    const j = censusAt(tmp)
    const after = statSync(join(tmp, 'out', '_probe', 'fab-census.json')).mtimeMs
    assert(before === after, '文件竟然被改了，这个用例前提不成立')
    // Q1：headline 是本机的 0，不是旧报告里的 999。
    assert(j.source === 'live', `source=${j.source}，期望 live（0 个目录是当场数的）`)
    assert(j.dirs === 0, `dirs=${j.dirs} —— 把旧报告里的 999 当成「你有多少目录」报了出来`)
    assert(j.fabOk === 0, `fabOk=${j.fabOk} —— 同上`)
    // Q2：文件没被重写，必须看得见。
    assert(j.refreshed === false, `refreshed=${j.refreshed}，期望 false`)
    // 旧报告的数字不能消失，但必须单独标着「这是谁的」。
    assert(j.snapshotDirs === 999, `snapshotDirs=${j.snapshotDirs}，期望 999`)
    assert(typeof j.corpusNote === 'string' && j.corpusNote.length > 20, '没解释那份快照描述的是谁')
    // `0/0` 不是 100%。
    assert(typeof j.emptyNote === 'string', 'dirs=0 却没给 emptyNote —— 会被读成 0/0 全过')
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

// 本机**有**产物，但量具没写出新报告 —— 这时 headline 只能来自那份旧文件，
// 必须标成 snapshot，也不能把时间戳写成「现在」。
check('本机有产物但量具没写新报告 → 标 snapshot，at 用文件时间不冒充现在', () => {
  const tmp = fakeRoot('import sys\nsys.exit(0)\n', STALE)
  // 造一个真的产物目录：`out/<name>/_run.json` 就是 census 认的样本单位。
  mkdirSync(join(tmp, 'out', 'FAKE-20260101-000000'), { recursive: true })
  writeFileSync(join(tmp, 'out', 'FAKE-20260101-000000', '_run.json'), '{"ok":true}', 'utf8')
  try {
    const before = statSync(join(tmp, 'out', '_probe', 'fab-census.json')).mtimeMs
    const j = censusAt(tmp)
    assert(j.source === 'snapshot', `source=${j.source}，期望 snapshot（headline 来自旧文件）`)
    assert(j.localDirs === 1, `localDirs=${j.localDirs}，期望 1`)
    assert(j.dirs === 999, `dirs=${j.dirs}，期望 999（这份 headline 就是旧文件的）`)
    assert(typeof j.sourceNote === 'string' && j.sourceNote.length > 10, 'snapshot 却没解释原因')
    // at 必须是那份文件的 mtime，不能是现在。
    assert(Math.abs(Date.parse(j.at) - before) < 5000, `at=${j.at} 不是报告文件的时间`)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
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
