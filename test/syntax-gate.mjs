#!/usr/bin/env node
/**
 * 全仓语法闸门。一个命令，覆盖 .js / .mjs / .cjs / .py / .ps1。
 *
 * ## 为什么不能直接用 `node --check`
 *
 * `AGENTS.md` 原文写的是「语法闸门：`.js` 用 `node --check`」。
 * 实测这条规则在**这个仓库里有一半文件上是错的**：
 *
 *     受跟踪 .js            186 个
 *     node --check 失败      92 个（≥49%）
 *     按真实形式解析失败      0 个
 *
 * 原因是 92 个 `.js` 不是模块，是 **`invoke` 交给 EDA 的函数体** ——
 * 它们本来就以顶层 `await` 开头，而 `node --check` 按 CommonJS 模块解析，
 * 顶层 `await` 在模块里非法，于是必然报 `await is only valid in async functions`。
 *
 * 后果不是「多跑一次」，是**每一个照 AGENTS.md 干活的人都会看到一次假红**。
 * 然后只有两种结局：要么他被吓住去「修」一个不是问题的问题，
 * 要么他学会忽略这个检查 —— 而后者会让真正的语法错误也一起被忽略。
 *
 * 所以闸门必须是：**文件按它真实的执行形式被解析**。
 *
 *   .js    先按 CommonJS 模块解析；失败再包成 `(async function(){ ... })`
 *          （invoke 函数体）；再失败按 ESM 模块解析。三者都不中才是真错。
 *   .mjs   真正的 ESM 模块 → 只按 ESM 解析
 *   .cjs   明确 CommonJS  → 只按 CommonJS 解析
 *   .py    `compile()` **且** 把 SyntaxWarning 升级成异常
 *          （单纯 py_compile 会放过 `'designs\<'` 这种无效转义）
 *   .ps1   PowerShell 语言解析器（`Parser::ParseFile`）
 *
 * ## 两级判决，和 test/dev-path-scan.mjs 同一套思路
 *
 * 能解析成 ESM、但所在目录的最近一层 `package.json` 没有 `"type": "module"`
 * 的 `.js`，`node` 是**加载不了**它的。但这有两种完全不同的严重性：
 *
 *   FAIL  有别的文件 `require`/`import` 它 → 一旦被加载就抛，是真故障
 *   WARN  没人引用它                      → 死文件，违反 AGENTS.md 第一条禁令
 *
 * 分开的理由和那边一样：把两种情况混成一个数字，`FAIL` 就不再指出该先修哪个。
 * `video/src/*.js` 属于 WARN 那类 —— 它们由 Remotion/webpack 编译，从来不经过
 * `node` 的模块解析，所以「Node 加载不了」对它们不构成故障，但也没人该在 `scripts/`
 * 里照着写。
 *
 * ## 用法
 *
 *   node test/syntax-gate.mjs                 # 扫全部被 git 跟踪的文件
 *   node test/syntax-gate.mjs a.js b.mjs      # 只查这几个
 *   node test/syntax-gate.mjs --json
 *
 * 退出码 0 = 无 FAIL；1 = 有 FAIL；2 = 环境问题（缺 python / pwsh）
 *
 * @module pcb-auto/test/syntax-gate
 */

import { spawnSync } from 'node:child_process'
import { gitLines } from './_git.mjs'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))

const ARGS = process.argv.slice(2)
const JSON_OUT = ARGS.includes('--json')
const NAMED = ARGS.filter((a) => !a.startsWith('--'))

const JS_EXT = '.js'
const ESM_EXT = new Set(['.mjs'])
const CJS_EXT = new Set(['.cjs'])

function trackedFiles() {
  // 走 _git.mjs：git 不存在时退 2（环境问题），不要崩成 1（= 发现了失败）。
  //
  // 已跟踪 ∪ 未跟踪（`--exclude-standard` 仍然尊重 .gitignore）。
  // 只用 `ls-files` 的后果是：**新写的文件永远不会被这条闸门检查**，
  // 而新文件恰恰是最可能带语法错误的那一批。实测有过 5 个未跟踪的代码文件
  // 从没被解析过 —— 其中 4 个就是闸门自己。
  // `doc-refs.mjs` 早就因为同样的理由把未跟踪文件算进来了。
  const tracked = gitLines(['ls-files', '-z'], { root: ROOT, nul: true })
  const untracked = gitLines(['ls-files', '-o', '--exclude-standard', '-z'], { root: ROOT, nul: true })
  return [...new Set([...tracked, ...untracked])]
}

/* ────────────────────────── .js 的三种执行形式 ────────────────────────── */

/** 最近的 `package.json` 决定 `.js` 是 CommonJS 还是 ESM —— 这是 Node 的真实规则。 */
function nearestPackage(relFile) {
  let dir = dirname(relFile.replace(/\\/g, '/'))
  for (;;) {
    const candidate = dir === '.' ? 'package.json' : `${dir}/package.json`
    if (existsSync(join(ROOT, candidate))) {
      try {
        const j = JSON.parse(readFileSync(join(ROOT, candidate), 'utf8'))
        return { file: candidate, type: j.type === 'module' ? 'module' : 'commonjs' }
      } catch (e) {
        return { file: candidate, type: 'commonjs', unparsable: e.message }
      }
    }
    if (dir === '.' || dir === '' || dir === '/' || dir === basename(dir)) return { file: null, type: 'commonjs' }
    const parent = dirname(dir)
    if (parent === dir) return { file: null, type: 'commonjs' }
    dir = parent
  }
}

/** 把源码解析成某种形式；只解析不执行。返回形式名，全都失败则抛最后一条错误。 */
function classifyJs(src) {
  try {
    new vm.Script(src, { filename: 'probe' })
    return 'commonjs'
  } catch (e1) {
    try {
      new vm.Script('(async function(){' + src + '\n})', { filename: 'probe' })
      return 'invoke-body'
    } catch {
      // 两种 node 形式都不行，最后试 ESM。ESM 不能用 vm.Script 解析，
      // 落到临时 .mjs 文件上跑一次 `node --check`（只有极少数文件会走到这里）。
      if (looksLikeModule(src)) return 'esm'
      throw e1
    }
  }
}

/**
 * 这个 `package.json` 所在的目录是不是**打包器工程**（源码由 webpack/Remotion/vite/tsc
 * 编译，从来不经过 Node 的模块解析）。
 *
 * 判据是机械的：那个目录里有没有打包器配置文件。不是靠人维护的名单，
 * 所以它不会腐烂 —— 删掉 `remotion.config.js` 这个目录就不再被当成打包器工程。
 */
const BUNDLER_CONFIG = /^(remotion|webpack|vite|rollup|esbuild|next|nuxt|astro|svelte)\.config\.(?:[cm]?[jt]s)$|^tsconfig(?:\..+)?\.json$|^\.babelrc/
function isBundlerProject(pkgFile) {
  if (!pkgFile) return null
  const dir = dirname(pkgFile)
  try {
    const entries = dir === '.' ? readdirSync(ROOT) : readdirSync(join(ROOT, dir))
    const hit = entries.find((e) => BUNDLER_CONFIG.test(e))
    return hit ? { dir: dir === '.' ? '.' : dir, config: hit } : null
  } catch {
    return null
  }
}

/** 便宜且足够准的判据：只看顶层语句形状。 */
function looksLikeModule(src) {
  return /^\s*(?:import|export)\s/m.test(src) || /^\s*export\s*\{/m.test(src)
}

/* ────────────────────────── 引用图（决定 FAIL / WARN） ────────────────────────── */

/**
 * 把所有「被当作模块引入」的 specifier 的 basename 收集起来。
 * 只认真正的模块引入形状，不认散文里出现的文件名 ——
 * 不然 `REVIEW-static.md` 里写一句 `design.js` 就会把一个死文件判成「有人在用」。
 */
function referencedStems(files) {
  const stems = new Set()
  const patterns = [
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const f of files) {
    let src
    try {
      src = readFileSync(join(ROOT, f), 'utf8')
    } catch {
      continue
    }
    for (const re of patterns) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(src))) {
        const spec = m[1]
        // 只吃相对路径和裸文件名；包名（@scope/x、node:fs）不参与
        if (spec.startsWith('node:') || /^[a-z@]/i.test(spec) && !spec.includes('/./') && !spec.startsWith('.')) {
          // 裸包名，跳过 —— 除非它就是一个同目录文件名（如 require('design')）
          if (!/^[A-Za-z0-9_.-]+$/.test(spec)) continue
        }
        const base = basename(spec).replace(/\.[cm]?js$/, '')
        if (base) stems.add(base)
      }
    }
  }
  return stems
}

/* ────────────────────────── python ────────────────────────── */

/** 找一个能用的 python。等价于 scripts/tool-paths.ps1 的 Resolve-Python，只是用 JS 写。 */
function findPython() {
  const cands = []
  for (const e of ['PCB_AUTO_PYTHON', 'PYTHON']) if (process.env[e]) cands.push(process.env[e])
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const local = process.env.LOCALAPPDATA || ''
  // 先找 DSH 自带运行时：本仓库的量具一直跑在它上面，顺序反了会悄悄换解释器
  for (const base of [join(home, '.dsh', 'dsh-runtimes'), local && join(local, 'dsh', 'dsh-runtimes')].filter(Boolean)) {
    if (!existsSync(base)) continue
    try {
      for (const d of readdirSync(base)) {
        for (const py of ['python.exe', 'python']) {
          const p = join(base, d, 'dependencies', 'python', py)
          if (existsSync(p)) cands.push(p)
        }
      }
    } catch { /* 忽略 */ }
  }
  cands.push('python3', 'python')
  for (const c of cands) {
    const r = spawnSync(c, ['-c', 'print(1)'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
    if (r.status === 0) return c
  }
  return null
}

function checkPython(files, python) {
  const prog = `
import json, sys, warnings
res = {}
for f in json.load(sys.stdin):
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", SyntaxWarning)
            with open(f, "rb") as fh:
                compile(fh.read(), f, "exec")
        res[f] = None
    except Exception as e:
        res[f] = f"{type(e).__name__}: {e}"
json.dump(res, sys.stdout)
`
  const r = spawnSync(python, ['-c', prog], {
    cwd: ROOT,
    input: JSON.stringify(files.map((f) => join(ROOT, f))),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300_000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  })
  if (r.status !== 0) {
    throw new Error(`批量 py_compile 失败（环境问题，不是语法问题）：\n${r.stderr || r.stdout}`)
  }
  let parsed
  try {
    parsed = JSON.parse(r.stdout)
  } catch {
    throw new Error(`py_compile 输出不是 JSON：${(r.stdout || '').slice(0, 300)}`)
  }
  const bad = new Map()
  for (const [abs, err] of Object.entries(parsed)) {
    if (err) bad.set(abs.slice(ROOT.length + 1).replace(/\\/g, '/'), err)
  }
  return bad
}

/* ────────────────────────── PowerShell ────────────────────────── */

function findPwsh() {
  for (const c of ['pwsh', 'powershell']) {
    const r = spawnSync(c, ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
    if (r.status === 0) return c
  }
  return null
}

function checkPowerShell(files, pwsh) {
  /*
   * 两个坑，都踩过了：
   *
   * 1. **不要用 stdin 把文件列表喂给 `pwsh -Command`。** 那条通道里 `$input`
   *    拿不到你以为的东西 —— 实测它会对着一个确实存在的文件报
   *    「Could not find a part of the path」。改成写临时文件再 Get-Content。
   *
   * 2. **不要让 PowerShell 输出 JSON。** 它的 `ConvertTo-Json` 不转义反斜杠，
   *    而路径全是反斜杠，于是 `D:\Users\...` 里的 `\U` 变成非法 JSON 转义，
   *    解析端直接炸。改成行标记：`@@FAIL@@路径` / `@@MSG@@消息`。
   *
   * 顺带把子进程的输出编码钉成 UTF-8 —— 否则中文错误信息会变成 cp936 乱码。
   */
  const listFile = join(tmpdir(), `syntax-gate-ps1-${process.pid}.txt`)
  // 用 `join(ROOT, f)` 而不是手工把 `/` 换成 `\` —— 后者在 Linux 上会变成
  // `scripts\x.ps1` 这种根本不存在的路径，然后在 CI 上报一堆假红。
  writeFileSync(listFile, files.map((f) => join(ROOT, f)).join('\n'), 'utf8')

  const prog = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
foreach ($f in (Get-Content -LiteralPath '${listFile.replace(/'/g, "''")}' -Encoding utf8)) {
  if (-not $f) { continue }
  $t = $null; $errs = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$t, [ref]$errs)
  if (@($errs).Count -gt 0) {
    $m = (@($errs) | ForEach-Object { $_.Message }) -join ' | '
    $m = $m -replace "\`r?\`n", ' | '
    Write-Output ("@@FAIL@@" + $f)
    Write-Output ("@@MSG@@" + $m)
  }
}
Write-Output '@@END@@'
`
  try {
    const r = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', prog], {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 300_000,
    })
    const text = `${r.stdout || ''}${r.stderr || ''}`
    if (!text.includes('@@END@@')) {
      throw new Error(`PowerShell 解析器没有跑完（环境问题，不是语法问题）：\n${text.slice(0, 800)}`)
    }
    const bad = new Map()
    let pending = null
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\s+$/, '')
      if (line.startsWith('@@FAIL@@')) pending = line.slice(8)
      else if (line.startsWith('@@MSG@@') && pending) {
        bad.set(pending.slice(ROOT.length + 1).replace(/\\/g, '/'), line.slice(7))
        pending = null
      }
    }
    return bad
  } finally {
    try { rmSync(listFile, { force: true }) } catch { /* 无所谓 */ }
  }
}

/* ────────────────────────── 主流程 ────────────────────────── */

function main() {
  const all = NAMED.length ? NAMED.map((f) => f.replace(/\\/g, '/')) : trackedFiles()
  const files = all.filter((f) => !f.includes('node_modules') && !f.includes('__pycache__'))

  const js = files.filter((f) => extname(f) === JS_EXT)
  const esm = files.filter((f) => ESM_EXT.has(extname(f)))
  const cjs = files.filter((f) => CJS_EXT.has(extname(f)))
  const py = files.filter((f) => extname(f) === '.py')
  const ps = files.filter((f) => ['.ps1', '.psm1'].includes(extname(f)))

  const stems = referencedStems(files)

  const failures = []
  const warnings = []
  const forms = { commonjs: 0, 'invoke-body': 0, esm: 0 }

  for (const f of js) {
    const src = readFileSync(join(ROOT, f), 'utf8')
    let form
    try {
      form = classifyJs(src)
    } catch (e) {
      failures.push({ file: f, kind: 'js', message: e.message })
      continue
    }
    forms[form] += 1

    if (form !== 'esm') continue

    // 能解析成 ESM，但 Node 会不会这样加载它？
    const pkg = nearestPackage(f)
    if (pkg.type === 'module') continue // 合法，package.json 说了这是 ESM

    const bundler = isBundlerProject(pkg.file)
    const stem = basename(f).replace(/\.js$/, '')
    const referenced = stems.has(stem)
    const head = `按 ESM 才能解析，但最近一层 package.json（${pkg.file || '仓库根'}）没有 "type": "module"。`

    if (bundler) {
      /*
       * 打包器工程：`video/src/*.js` 由 Remotion/webpack 编译，从来不经过 Node
       * 的模块解析，所以「Node 加载不了」对它们不构成故障。
       * 判成 WARN 而不是 FAIL —— 但也不许它悄无声息，因为它示范了一种
       * 在 `scripts/` 里照写就会炸的写法。
       */
      warnings.push({
        file: f,
        kind: 'js',
        message:
          `${head}\n但 ${bundler.dir} 是打包器工程（有 ${bundler.config}），`
          + `这些源码由打包器编译，不经过 Node 的模块解析 —— 所以不算故障。\n`
          + `注意：这种写法只能放在打包器目录里。同样的写法出现在 scripts\\ 下就是真的会炸。`,
      })
      continue
    }

    const detail = {
      file: f,
      kind: 'js',
      message:
        `${head}\n`
        + `Node 会在 CommonJS 模式下加载它，然后抛 "Cannot use import statement outside a module"。`
        + (referenced
          ? `\n而且**有文件引用它** —— 一旦被加载就会抛，这是真故障。`
          : `\n目前没有任何文件引用它（死文件），所以还没炸 —— 但它违反了 AGENTS.md 第一条禁令。`),
    }
    if (referenced) failures.push(detail)
    else warnings.push(detail)
  }

  for (const f of esm) {
    const r = spawnSync(process.execPath, ['--check', join(ROOT, f)], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
    if (r.status !== 0) {
      failures.push({
        file: f,
        kind: 'mjs',
        message: `${r.stderr || r.stdout}`.split(/\r?\n/).filter(Boolean).slice(0, 6).join('\n'),
      })
    }
  }
  for (const f of cjs) {
    const r = spawnSync(process.execPath, ['--check', join(ROOT, f)], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
    if (r.status !== 0) {
      failures.push({
        file: f,
        kind: 'cjs',
        message: `${r.stderr || r.stdout}`.split(/\r?\n/).filter(Boolean).slice(0, 6).join('\n'),
      })
    }
  }

  if (py.length) {
    const python = findPython()
    if (!python) {
      console.error('找不到可用的 python —— 无法检查 .py。设置 PCB_AUTO_PYTHON。')
      return 2
    }
    let bad
    try {
      bad = checkPython(py, python)
    } catch (e) {
      console.error(e.message)
      return 2
    }
    for (const [file, message] of bad) failures.push({ file, kind: 'py', message })
  }

  if (ps.length) {
    const pwsh = findPwsh()
    if (!pwsh) {
      console.error('找不到可用的 PowerShell —— 无法检查 .ps1。')
      return 2
    }
    let bad
    try {
      bad = checkPowerShell(ps, pwsh)
    } catch (e) {
      console.error(e.message)
      return 2
    }
    for (const [file, message] of bad) failures.push({ file, kind: 'ps1', message })
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({
      counts: { js: js.length, mjs: esm.length, cjs: cjs.length, py: py.length, ps1: ps.length },
      forms,
      failures,
      warnings,
    }, null, 2))
  } else {
    console.log(`  .js  ${js.length} 个（CommonJS ${forms.commonjs} / invoke 函数体 ${forms['invoke-body']} / ESM ${forms.esm}）`)
    console.log(`  .mjs ${esm.length} 个   .cjs ${cjs.length} 个   .py ${py.length} 个   .ps1 ${ps.length} 个`)

    if (warnings.length) {
      console.log('')
      for (const w of warnings) {
        console.log(`  \x1b[33mWARN\x1b[0m  ${w.file}`)
        console.log(`        ${w.message.split('\n').join('\n        ')}`)
      }
    }
    if (failures.length) {
      console.log('')
      for (const f of failures) {
        console.log(`  \x1b[31mFAIL\x1b[0m  ${f.file}  (${f.kind})`)
        console.log(`        ${f.message.split('\n').join('\n        ')}`)
      }
    }
    console.log('')
    // 「共 N 个文件全部通过」是**分母注水**：`files` 里有大量 `.md` / `.json` /
    // `.csv` 根本没有可检的语法，它们不是「通过」，是「没检」。
    // 以前这里写 `共 ${files.length} 个文件`，读数比真正解析过的多一倍以上 ——
    // 和「dirs: 0 读成 100%」是同一类错误的另一种形状。
    const checked = js.length + esm.length + cjs.length + py.length + ps.length
    const skipped = files.length - checked
    if (checked === 0) {
      // 一个文件都没解析过时的 PASS 不叫通过，叫没有样本。
      console.log('  SYNTAX=NO-SAMPLE  0 个文件被解析 —— 这不是通过。检查 ROOT 与 git 是否指对了仓库。')
      console.log(`  另 ${skipped} 个文件没有可检语法（.md/.json/.csv…），从未被解析。`)
      return 2
    }
    console.log(
      failures.length
        ? `  SYNTAX=FAIL   ${failures.length} 个真错 / ${warnings.length} 个警告 / 解析了 ${checked} 个文件`
        : `  SYNTAX=PASS   ${checked} 个有可检语法的文件全部通过${warnings.length ? `（${warnings.length} 个警告）` : ''}`,
    )
    console.log(`                另 ${skipped} 个文件没有可检语法（.md/.json/.csv…），未解析 —— 它们不算「通过」。`)
    if (forms['invoke-body']) {
      console.log(`  注：${forms['invoke-body']} 个 .js 是 invoke 函数体，\`node --check\` 对它们必然假红 —— 这里按真实形式解析。`)
    }
  }
  return failures.length ? 1 : 0
}

process.exit(main())
