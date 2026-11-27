#!/usr/bin/env node
/**
 * pcb-auto · DSH 插件契约测试
 *
 * 测什么：`plugin/index.js` 被 `apply()` 之后，是否真的往工具注册表里放下了
 * 5 个工具，名字/参数/行为是否和 `core/ops.mjs` 的 OPS 表一致。
 *
 * 为什么需要单独一套：`test/smoke.mjs` 只做静态检查（文件在、能语法通过、
 * 动态 import 的是 core）。但「注册了哪些工具」是运行期事实，静态查不出来。
 * 而这两个宿主包只存在于 DSH 进程里，所以这里用加载器钩子把它们换成桩 ——
 * 被测的 `plugin/index.js` 一字不改。
 *
 * 不重启 DSH、不启动服务器。
 *
 * 会**写盘一次**：`pcb_census` 的 live 扫描把结果写到 `out/_probe/fab-census.json`，
 * 而那份文件同时是随仓库发布的证据（`docs/FAILURES.md` 第 15 条、`交付-README.md`
 * 都引它的 `measured_at`）。所以这里先存后还，并断言字节完全相同。
 *
 *   node test/plugin-harness.mjs
 *
 * 退出码 0 = 全过；1 = 有断言失败。
 */

import { register } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(join(HERE, '..'))

// 必须在 import 插件之前注册。静态 import 会被提升，所以下面一律用动态 import。
// 注意 register 的第一个参数是**相对说明符**，相对第二个参数（本文件）解析。
// 传绝对 file:// URL 会被当成相对路径再拼一次（会得到 dsh-stubs/dsh-stubs/…）。
register('./dsh-stubs/resolver.mjs', import.meta.url)

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

/** 假 ctx：只提供插件 inject 的 `tools` 服务。 */
const makeCtx = () => {
  const tools = []
  return {
    tools: {
      register(tool) { tools.push(tool) },
    },
    _tools: tools,
  }
}

console.log('\n\x1b[1mDSH 插件契约\x1b[0m')

const plugin = await import(pathToFileURL(join(ROOT, 'plugin', 'index.js')).href)
const core = await import(pathToFileURL(join(ROOT, 'core', 'ops.mjs')).href)

check('插件导出 name / inject / Config / apply', () => {
  assert(typeof plugin.name === 'string' && plugin.name, '缺 name')
  assert(Array.isArray(plugin.inject), 'inject 必须是数组')
  assert(plugin.inject.includes('tools'), `inject 不含 'tools'：${JSON.stringify(plugin.inject)}`)
  assert(plugin.Config && plugin.Config.__shape, 'Config 不是 z.object')
  assert(typeof plugin.apply === 'function', '缺 apply')
  return `name=${plugin.name} inject=[${plugin.inject.join(',')}]`
})

check('Config 的两个字段都是「可选」（写死必填会让安装直接失败）', () => {
  const shape = plugin.Config.__shape
  const keys = Object.keys(shape)
  assert(keys.length === 2, `期望 2 个字段，实际 ${keys.length}：${keys.join(',')}`)
  for (const k of keys) {
    assert(shape[k] && shape[k].__required === false, `${k} 不是可选的 —— 用户不填就会安装失败`)
  }
  return keys.join(', ')
})

const ctx = makeCtx()
let applyErr = null
try {
  await plugin.apply(ctx, {})
} catch (e) {
  applyErr = e
}

check('apply() 能跑完（不需要任何配置）', () => {
  assert(!applyErr, `apply 抛了：${applyErr && applyErr.message}`)
  return `注册 ${ctx._tools.length} 个工具`
})

check('注册的工具数与 core 的 OPS 表一一对应', () => {
  const want = Object.keys(core.OPS).length
  assert(ctx._tools.length === want, `注册 ${ctx._tools.length} 个，OPS 有 ${want} 个`)
  return `${want} 个`
})

check('工具名是 pcb_ 前缀 + 连字符转下划线', () => {
  const got = ctx._tools.map((t) => t.name).sort()
  const want = Object.keys(core.OPS).map((k) => `pcb_${k.replace(/-/g, '_')}`).sort()
  assert(JSON.stringify(got) === JSON.stringify(want), `实际 [${got}] 期望 [${want}]`)
  return got.join(' ')
})

check('每个工具的参数声明与 core 的 args 一致', () => {
  const problems = []
  for (const [opName, op] of Object.entries(core.OPS)) {
    const tool = ctx._tools.find((t) => t.name === `pcb_${opName.replace(/-/g, '_')}`)
    if (!tool) { problems.push(`${opName}: 没有对应工具`); continue }
    const wantKeys = Object.keys(op.args || {}).sort()
    const gotKeys = Object.keys(tool.parameters || {}).sort()
    if (JSON.stringify(wantKeys) !== JSON.stringify(gotKeys)) {
      problems.push(`${opName}: 参数 ${JSON.stringify(gotKeys)} ≠ ${JSON.stringify(wantKeys)}`)
      continue
    }
    for (const k of wantKeys) {
      const want = op.args[k]
      const got = tool.parameters[k]
      const wantType = want.type === 'integer' ? 'number' : want.type
      if (got.type !== wantType) problems.push(`${opName}.${k}: type ${got.type} ≠ ${wantType}`)
      const wantReq = Boolean(want.required)
      if (Boolean(got.required) !== wantReq) {
        problems.push(`${opName}.${k}: required ${Boolean(got.required)} ≠ ${wantReq}`)
      }
    }
  }
  assert(problems.length === 0, problems.join('\n'))
  return `${Object.keys(core.OPS).length} 个工具的参数都对得上`
})

check('每个工具都有可渲染的 output（描述 + render）', () => {
  for (const t of ctx._tools) {
    assert(typeof t.description === 'string' && t.description.length > 20, `${t.name}: description 太短`)
    assert(t.output && t.output.schema, `${t.name}: 缺 output.schema`)
    assert(typeof t.output.render === 'function', `${t.name}: 缺 output.render`)
  }
  return `${ctx._tools.length} 个`
})

// `pcb_census` 的 live 扫描会**写盘**：它的输出路径就是
// `out/_probe/fab-census.json`（`core/ops.mjs:426`），而同一份文件又是随仓库
// 发布的证据 —— `docs/FAILURES.md` 第 15 条和 `交付-README.md` 的
// 「测于 2026-11-26T11:33:01+08:00」都直接引它。
//
// 实测 2026-11-26T16:2x：不加这一步时，跑一次这条闸门就把证据换成新数字
// （dirs 56 → 60，199 insertions / 68 deletions），`git status` 多出一处 out/ 改动，
// 而文档里的 56/53 没跟着变 —— 文档与证据从此不一致，且没有任何闸门会红。
//
// 一条只读闸门不该有这种副作用。`test/smoke.mjs` 早就是这么做的（存、跑、还）。
const EVIDENCE = join(ROOT, 'out', '_probe', 'fab-census.json')
// 它是受版本控制的文件。缺了就说明这份检出坏了 —— 那样「有没有被改写」根本无从测量，
// 不能当成通过。
const evidenceBefore = existsSync(EVIDENCE) ? readFileSync(EVIDENCE) : null

// 真正跑一次：证明「插件 → core → 子进程」这条链没断。
let censusResult = null
let censusErr = null
try {
  const tool = ctx._tools.find((t) => t.name === 'pcb_census')
  assert(tool, '找不到 pcb_census')
  censusResult = await tool.execute({}, { signal: undefined })
} catch (e) {
  censusErr = e
} finally {
  if (evidenceBefore !== null) writeFileSync(EVIDENCE, evidenceBefore)
}

check('pcb_census.execute() 真的跑到了 core（端到端）', () => {
  assert(!censusErr, `execute 抛了：${censusErr && censusErr.message}`)
  assert(censusResult && typeof censusResult === 'object', '返回值不是对象')
  assert(typeof censusResult.exitCode === 'number', '返回值缺 exitCode')
  // source 是这次修的字段：证明拿到的是真实现，不是某个壳子的自述。
  assert(['live', 'snapshot', 'none'].includes(censusResult.source),
    `source=${censusResult.source} 不在 live/snapshot/none 里`)
  if (censusResult.source === 'none') {
    throw new Error(`量具没跑成：${censusResult.reason}\n${(censusResult.raw || '').slice(0, 400)}`)
  }
  return `exitCode=${censusResult.exitCode} source=${censusResult.source} dirs=${censusResult.dirs}`
})

check('实跑 census 之后把发布的证据文件还回去了（字节一致）', () => {
  assert(evidenceBefore !== null,
    'out/_probe/fab-census.json 不存在 —— 它是随仓库发布的证据，缺了就无法测量是否被覆盖')
  const after = readFileSync(EVIDENCE)
  assert(Buffer.compare(after, evidenceBefore) === 0,
    `out/_probe/fab-census.json 被改写了（${evidenceBefore.length} B → ${after.length} B）—— `
    + '它是 docs/FAILURES.md 第 15 条和 交付-README.md 引用的证据，必须在跑完还回去')
  return `${evidenceBefore.length} B 一字不差`
})

check('render 能把真实结果渲染成文本（模型看到的就是这个）', () => {
  const tool = ctx._tools.find((t) => t.name === 'pcb_census')
  const blocks = tool.output.render({}, censusResult)
  assert(Array.isArray(blocks) && blocks.length > 0, 'render 没返回块数组')
  assert(blocks.every((b) => b && b.type === 'text' && typeof b.text === 'string'), '块格式不对')
  const text = blocks.map((b) => b.text).join('\n')
  assert(text.length > 10, '渲染出来是空的')
  // 渲染里必须带上时刻和分母 —— 这是这个项目自己的规矩。
  assert(text.includes('普查'), '渲染里没有主旨')
  assert(/目录/.test(text), '渲染里没有目录数（分母）')
  return text.split('\n')[0].slice(0, 60)
})

// ── 打包完整性：`files` 里漏一个被 import 的模块，发布出去就是断的 ──────
// 真实缺陷（2026-11-27 发现）：`index.js` 静态 import `./locate-root.mjs`，
// 而 `package.json` 的 `files` 里没有它 ⇒ 按 files 打包后插件在别人机器上
// 一加载就 `ERR_MODULE_NOT_FOUND`。本地永远复现不出来，因为本地是整个目录。
// 这条检查把「被 import 的相对模块」逐个对回 `files`。
check('打包完整性：被 import 的相对模块都在 package.json 的 files 里', () => {
  const PLUGIN = join(ROOT, 'plugin')
  const pkgPath = join(PLUGIN, 'package.json')
  assert(existsSync(pkgPath), '缺 plugin/package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const files = Array.isArray(pkg.files) ? pkg.files : []
  assert(files.length > 0, 'package.json 没有 files 数组 —— 会把整个目录都发出去')

  // files 条目 → 判定函数。目录名包含其下全部内容；其余按 glob 的 * 语义处理。
  const toRel = (abs) => abs.slice(PLUGIN.length + 1).replace(/\\/g, '/')
  const covered = (rel) => files.some((pat) => {
    const p = pat.replace(/\\/g, '/')
    if (!p.includes('*')) {
      if (rel === p) return true
      const abs = join(PLUGIN, p)
      return existsSync(abs) && statSync(abs).isDirectory() && rel.startsWith(p + '/')
    }
    const rx = new RegExp('^' + p.split('*').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$')
    return rx.test(rel)
  })

  // 从入口出发，递归收集相对 import（只跟 .js/.mjs；node: 与包名跳过）
  const seen = new Set()
  const missing = []
  const entry = join(PLUGIN, 'index.js')
  assert(existsSync(entry), '缺 plugin/index.js')
  const walk = (abs) => {
    const rel = toRel(abs)
    if (seen.has(rel)) return
    seen.add(rel)
    const src = readFileSync(abs, 'utf8')
    for (const m of src.matchAll(/from\s+'(\.\.?\/[^']+)'/g)) {
      let dep = resolve(dirname(abs), m[1])
      if (!dep.endsWith('.mjs') && !dep.endsWith('.js')) dep += '.mjs'
      if (!existsSync(dep) && dep.endsWith('.mjs') && existsSync(dep.replace(/\.mjs$/, '.js'))) {
        dep = dep.replace(/\.mjs$/, '.js')
      }
      assert(existsSync(dep), `import 的目标不存在：${m[1]}（来自 ${rel}）`)
      const depRel = toRel(dep)
      if (!covered(depRel)) missing.push(`${depRel}（被 ${rel} import，但 files 里没有）`)
      walk(dep)
    }
  }
  walk(entry)

  assert(missing.length === 0, '以下模块会被漏掉：\n      ' + missing.join('\n      '))
  // 入口与 dsh.bundle.patch 也必须真的存在，否则装上就是坏的
  for (const k of [pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch].filter(Boolean)) {
    assert(existsSync(join(PLUGIN, k)), `dsh.bundle.patch 指向的文件不存在：${k}`)
  }
  return `${seen.size} 个模块，files 覆盖 ${files.length} 条规则`
})

console.log('\n────────────────────────────────────────────────────────────')
if (failures.length === 0) {
  console.log(`  \x1b[32mPLUGIN=PASS\x1b[0m   ${pass} 项全过`)
  console.log('────────────────────────────────────────────────────────────\n')
  process.exit(0)
} else {
  console.log(`  \x1b[31mPLUGIN=FAIL\x1b[0m   ${pass} 过 / ${failures.length} 失败`)
  for (const f of failures) console.log(`    ✗ ${f.name}`)
  console.log('────────────────────────────────────────────────────────────\n')
  process.exit(1)
}
