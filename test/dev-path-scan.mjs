#!/usr/bin/env node
/**
 * 扫描被 git 跟踪的文件里有没有「开发者本机痕迹」。
 *
 * 为什么单独一个脚本而不是塞在测试里：这个扫描要被两个地方用 ——
 * `test/smoke.mjs` 拿它做断言，人也可以直接跑它看现状。
 *
 * ## 为什么分两级
 *
 * 第一版只有一个总数，结果是：65 个文件命中，而 `test/smoke.mjs` 里那道
 * 「开发者路径」闸门只查 4 个文件、报 76/76 全绿。这就是最坏的一种测试：
 * 它不但没发现问题，还让所有人以为没有问题。
 *
 * 但把 65 个文件全都改掉也是错的 —— 里面有历史补丁记录、一次性探针、
 * 抓下来的运行参数，那些东西的**存在本身就是证据**，改掉等于篡改记录。
 *
 * 所以分两级：
 *
 *   functional  一个照文档去用的人真的会执行到的文件。**必须为 0。**
 *   historical  历史记录 / 一次性探针 / 渲染产物。逐条列出理由，允许存在，
 *               但每一条豁免都必须在当前仓库里**真的命中至少一处**。
 *
 * 最后那条是关键：豁免不是「关掉检查」，而是「点名」。哪天那些文件被清干净了，
 * 对应的豁免就命不中，检查会失败，逼着人把它删掉。这样豁免表不会自己腐烂。
 *
 * 判定规则刻意写得窄：只认**明确的个人/机器标识**，不认一切绝对路径。
 * 因为文档里合法地引用别人的路径（举例、配置占位、历史命令）是正常的，
 * 把它们全判成 bug 会让这个检查变成噪音，然后所有人学会忽略它。
 *
 *   node test/dev-path-scan.mjs            # 人读
 *   node test/dev-path-scan.mjs --json     # 机器读
 *
 * 退出码：0 = 功能级 0 处且豁免都还活着；1 = 有功能级命中，或有失效豁免。
 *
 * @module pcb-auto/test/dev-path-scan
 */

import { gitLines } from './_git.mjs'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))

/** 只扫这些扩展名 —— 二进制里搜字符串没有意义。 */
const TEXT_EXT = /\.(md|txt|json|jsonc|ya?ml|mjs|cjs|js|jsx|ts|tsx|py|ps1|psm1|sh|cfg|ini|toml|csv|cff|html|css)$/i

/**
 * 什么算「本机痕迹」。
 * 每条都要能一句话解释为什么它不该出现在别人的克隆里。
 */
const RULES = [
  {
    id: 'developer-path',
    // D:\Users\陶鑫旺 或 D:/Users/陶鑫旺 —— 带开发者用户名的绝对路径
    re: /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}陶鑫旺/g,
    why: '带开发者用户名的绝对路径',
  },
  {
    id: 'dev-node-path',
    // 开发机的 Node 安装位置
    re: /[A-Za-z]:[\\/]{1,2}APP[\\/]{1,2}nodejs\d*/g,
    why: '写死开发机的 Node 安装位置',
  },
  {
    id: 'dev-eda-path',
    re: /[A-Za-z]:[\\/]{1,2}APP[\\/]{1,2}lceda-pro/gi,
    why: '写死开发机的 EDA 安装位置',
  },
  {
    id: 'dev-ffmpeg-path',
    re: /[A-Za-z]:[\\/]ffmpeg[\\/]bin/gi,
    why: '写死开发机的 ffmpeg 位置',
  },
  {
    id: 'dev-python-path',
    re: /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}UserX[\\/]{1,2}\.dsh/g,
    why: '写死某台机器的 DSH 运行时 Python 位置',
  },
  {
    id: 'dev-obsidian-path',
    re: /Obsidian Vault/gi,
    why: '开发者本机知识库路径',
  },
]

/**
 * 点名的豁免。每条都必须：有理由、并且在当前仓库里真的命中。
 * `re` 匹配的是**相对仓库根的路径**（正斜杠）。
 */
const EXEMPT = [
  {
    id: 'probe-records',
    re: /^out\//,
    why: 'out\\ 下是历史补丁记录与一次性探针（*.pre-*.py 是打补丁前的快照，' +
      'mk*.py 是一次性生成器）。这些文件的价值就在于它们记录的是**当时**的状态，' +
      '改写路径等于篡改记录。它们也不在 package.json 的 files 里，不会发给用户。',
  },
  {
    id: 'one-shot-patch-scripts',
    re: /^scripts\/\.[^/]*$/,
    why: 'scripts\\ 下点开头的一次性补丁脚本（.patch-*.ps1）。跑过一次就作废，' +
      '名字本身就是「别用它」的标记。',
  },
  {
    id: 'patchwork',
    re: /^scripts\/\.patchwork\//,
    why: '.patchwork\\ 是批量改写脚本的中间产物，不是可执行入口。',
  },
  {
    id: 'scratch-probes',
    re: /^scripts\/_[^/]*\.(ps1|json)$/,
    why: 'scripts\\ 下下划线开头的临时探针与抓下来的运行参数。' +
      '下划线前缀在本仓库里一直表示「不是交付物」。',
  },
  {
    id: 'captured-run-args',
    re: /^scripts\/d7d8-args-[^/]*\.json$/,
    why: 'd7d8 回归测试当时**实际传进去**的参数快照，含 outDir 的绝对路径。' +
      '改成相对路径就不再是当时那份参数了。',
  },
  {
    id: 'analysis-notes',
    re: /^scripts\/[^/]*\.md$/,
    why: 'scripts\\ 下的历史分析笔记（DESIGN-REPAIR / FAB-GAPS / REVIEW-static），' +
      '里面引用的命令带当时的绝对路径。它们是调查记录，不是使用说明。',
  },
  {
    id: 'render-artifacts',
    re: /^video\/public\//,
    why: 'video\\public\\ 是渲染输入/产物（manifest、素材清单），由录制脚本生成，' +
      '重新录制就会覆盖。',
  },
  {
    id: 'environment-facts',
    re: /^AGENTS\.md$/,
    why: 'AGENTS.md 的「环境事实」块是**故意**写成本机绝对路径的：它的读者是' +
      '下一个在这台机器上干活的模型，写成相对路径就没有信息量了。',
  },
]

/**
 * 这些文件本身就是在**规定**「不许有开发者路径」，命中的是规则文本而非数据。
 * 少一个就会自我命中；多一个就可能藏真问题，所以只有明确理由才加。
 */
const SELF_REFERENTIAL = new Set([
  'test/dev-path-scan.mjs',
])

/** 被跟踪的文本文件清单。
 *
 * 已跟踪 ∪ 未跟踪（`--exclude-standard` 仍尊重 `.gitignore`）。
 *
 * 为什么必须含未跟踪：这条闸门第一次上线时只看已跟踪文件，于是在
 * `scripts/tool-paths.ps1` 还**未提交**的时候对它报 PASS ——
 * 而那个文件的注释里正好写着两条作者机器路径。也就是说：
 * **闸门对它本该检查的那个文件一直亮绿灯，只因为那个文件还没 commit。**
 * 新写的文件恰恰是最可能引入本机路径的一批，所以这条必须和
 * `syntax-gate` / `doc-refs` 一样把未跟踪算进来。
 */
export function trackedFiles(root = ROOT) {
  const tracked = gitLines(['ls-files', '-z'], { root, nul: true })
  const untracked = gitLines(['ls-files', '-o', '--exclude-standard', '-z'], { root, nul: true })
  return [...new Set([...tracked, ...untracked])].filter((f) => TEXT_EXT.test(f))
}

/** 相对路径 → 豁免条目（没有就返回 null） */
function exemptionFor(rel) {
  const posix = rel.replace(/\\/g, '/')
  for (const e of EXEMPT) if (e.re.test(posix)) return e
  return null
}

/**
 * @returns {{file: string, line: number, rule: string, why: string,
 *            sample: string, severity: 'functional'|'historical',
 *            exemptBy: string|null}[]}
 */
export function scan(root = ROOT, { files } = {}) {
  const list = files || trackedFiles(root)
  const hits = []
  for (const rel of list) {
    if (SELF_REFERENTIAL.has(rel.replace(/\\/g, '/'))) continue
    let text
    try {
      text = readFileSync(join(root, rel), 'utf8')
    } catch {
      continue // 二进制 / 无权限：跳过
    }
    const exempt = exemptionFor(rel)
    const lines = text.split(/\r?\n/)
    for (const rule of RULES) {
      rule.re.lastIndex = 0
      for (let i = 0; i < lines.length; i++) {
        const m = rule.re.exec(lines[i])
        rule.re.lastIndex = 0
        if (!m) continue
        hits.push({
          file: rel,
          line: i + 1,
          rule: rule.id,
          why: rule.why,
          // 只留一小段，避免把整行私密内容打进 CI 日志
          sample: m[0].slice(0, 60),
          severity: exempt ? 'historical' : 'functional',
          exemptBy: exempt ? exempt.id : null,
        })
      }
    }
  }
  return hits
}

/**
 * 豁免表的健康度：每条豁免有没有真的命中。
 * 命不中 = 那份文件已经不脏了，豁免该删；留着只会让人以为还有债。
 */
export function exemptionHealth(hits) {
  const live = new Set(hits.map((h) => h.exemptBy).filter(Boolean))
  return EXEMPT.map((e) => ({ id: e.id, why: e.why, hits: live.has(e.id) }))
}

/** 便于外部断言豁免表本身没写错（正则能编译、id 不重复）。 */
export function exemptionIds() {
  return EXEMPT.map((e) => e.id)
}

/** 总账。`functional` 必须为 0；`deadExemptions` 必须为空。 */
export function summary(hits) {
  const functional = hits.filter((h) => h.severity === 'functional')
  const historical = hits.filter((h) => h.severity === 'historical')
  const dead = exemptionHealth(hits).filter((e) => !e.hits)
  return {
    functional: functional.length,
    historical: historical.length,
    functionalFiles: [...new Set(functional.map((h) => h.file))].length,
    historicalFiles: [...new Set(historical.map((h) => h.file))].length,
    deadExemptions: dead.map((e) => e.id),
    ok: functional.length === 0 && dead.length === 0,
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const hits = scan()
  const s = summary(hits)

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ...s, hits, exemptions: exemptionHealth(hits) }, null, 2))
  } else {
    const show = (label, subset) => {
      if (!subset.length) {
        console.log(`  ${label}：0 处`)
        return
      }
      const byFile = new Map()
      for (const h of subset) {
        if (!byFile.has(h.file)) byFile.set(h.file, [])
        byFile.get(h.file).push(h)
      }
      console.log(`  ${label}：${subset.length} 处，分布在 ${byFile.size} 个文件`)
      for (const [file, hs] of [...byFile].sort()) {
        console.log(`    ${file}  (${hs.length})`)
        for (const h of hs.slice(0, 3)) console.log(`        L${h.line}  ${h.rule}  ${h.sample}`)
        if (hs.length > 3) console.log(`        … 还有 ${hs.length - 3} 处`)
      }
    }

    show('功能级（必须 0）', hits.filter((h) => h.severity === 'functional'))
    console.log('')
    show('历史级（点名豁免，允许存在）', hits.filter((h) => h.severity === 'historical'))

    console.log('\n  豁免表健康度：')
    for (const e of exemptionHealth(hits)) {
      console.log(`    ${e.hits ? '✓ 命中' : '✗ 失效'}  ${e.id}`)
      if (!e.hits) console.log(`        该删了：这份文件已经不脏，豁免留着只会让人以为还有债。理由原本是「${e.why.slice(0, 40)}…」`)
    }

    console.log('\n  ── 判决 ──')
    console.log(`    功能级 ${s.functional} 处 / 历史级 ${s.historical} 处 / 失效豁免 ${s.deadExemptions.length} 条`)
    console.log(`    ${s.ok ? 'PASS 别人的克隆里没有会炸的本机路径' : 'FAIL'}`)
  }

  process.exit(s.ok ? 0 : 1)
}
