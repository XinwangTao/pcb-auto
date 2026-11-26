#!/usr/bin/env node
/**
 * 文档引用闸门：核对文档里每一个 `文件:行号` 还能不能指到东西。
 *
 * ## 为什么需要
 *
 * `docs/FAILURES.md` 的全部可信度来自「每条都给了代码位置」。位置一旦烂掉，
 * 它就从「自查记录」变成「编造证据」—— 而且烂得很难看：引用指向空白行，
 * 或者指向 `}`，读者只会得出一个结论：作者没读过自己引的代码。
 *
 * 第一次跑这个闸门，就在 `docs/FAILURES.md` 里抓到了真烂的引用。它自己也差点
 * 变成第二个反面教材，见下面三个坑。
 *
 * ## 三个坑（都是写这一版时踩的）
 *
 * **坑 1：零样本判通过。** 第一版把带 `$` 锚点的正则拼进去，一条都没匹配上，
 * 输出「0 处引用，PASS」。这跟 `dirs: 0` 读成「全部通过」是同一个错误。
 * 现在先拿一条已知样本自检正则，再要求样本数 > 0，否则判闸门自身故障。
 *
 * **坑 2：中文文件名被静默截断。** 路径字符类里只写了 `[A-Za-z0-9_./\\-]`，
 * 于是 `交付-README.md:44-45` 被截成 `README.md:44-45`，然后去核对**另一个文件**的
 * 第 44、45 行，报了个假红。一个会误读中文文件名的闸门，在中文文档上给出的
 * 每一个判决都不可信。现在字符类用 `\p{L}`，包含中日韩。
 *
 * **坑 3：把范围引用里的空行当真错。** `_test-snap-dot.js:65-75` 这种引用本来
 * 就跨过空行，逐行要求非空必然假红。现在只要求范围的**两个端点**非空。
 *
 * ## 两级判决
 *
 * - **FAIL**：已发布文档（`docs/`、根目录 README 等）里的引用。这些是给别人看的，
 *   指错了就是错。
 * - **WARN**：`scripts/*.md` 这类分析记录。它们记的是「当时看到什么」，
 *   行号腐烂是历史事实的一部分，不该拦住提交。但**必须被数出来并打印**，
 *   否则又会变成「只查 4 个文件却报全绿」。
 *
 * ## 不能查什么
 *
 * 行号整体位移后落到**另一个有意义的行**上。这种只能靠人读。所以每节末尾那些
 * `grep -n ...` 才是真正不会腐烂的定位信息，行号只是方便。
 *
 * ## 用法
 *
 *   node test/doc-refs.mjs        # 退出码 0 = 发布文档全部指得准；1 = 有烂引用
 *
 * @module pcb-auto/test/doc-refs
 */

import { gitLines } from './_git.mjs'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))

/* ────────────────────────── 引用识别 ────────────────────────── */

const REF_EXT_SRC = String.raw`\.(?:js|mjs|cjs|py|ps1|json|md)`
const REF_RE = new RegExp(
  // `\p{L}` 而不是 `[A-Za-z]` —— 否则「交付-README.md」会被截成「README.md」，
  // 然后去核对另一个文件，给出一个看起来很确定、其实是错的判决。
  String.raw`([\p{L}\p{N}_][\p{L}\p{N}_./\\-]*` + REF_EXT_SRC + String.raw`)`
  + String.raw`:\s*(\d+(?:\s*[-–,]\s*\d+)*)`
  // 【可选的内容锚点】紧跟行号的一对双引号。`file:123 "const X = 4;"` 表示
  // 「第 123 行必须还含这段文字」。没有锚点的引用行为完全不变 —— 这是纯增量，
  // 现有发布引用一条都不用改就能继续过。之所以不判「这一行非空」就完事：
  // 非空只挡得住「指针落进空行」这一种腐烂，而行号整体位移落到**另一个有意义的行**
  // 上时，它一个字都不会说（实测：run-all.ps1 插 70 行，56 处引用全错，闸门全绿）。
  + String.raw`(?:\s+"([^"\n]{1,120})")?`,
  'gu',
)

/** 已发布文档：这里的引用指错了就是错。 */
const isPublished = (rel) =>
  /^docs\//.test(rel)
  || /^[^/]+\.md$/.test(rel)
  || /^(?:交付-README|SPEC)\.md$/.test(rel)
  || /^llms\.txt$/.test(rel)

function mdFiles() {
  // 走 _git.mjs：git 不存在时退 2，而不是崩成 1（=「发现文档引用坏了」）。
  const git = (args) =>
    gitLines(['-c', 'core.quotepath=false', ...args], { root: ROOT, maxBuffer: 32 << 20 })
  // 未跟踪的也要算：`docs/FAILURES.md` 进仓库时就是未跟踪状态，
  // 只用 ls-files 会把它整个漏掉，而它恰好是最需要核的那份。
  const all = [
    ...git(['ls-files', '*.md']),
    ...git(['ls-files', '-o', '--exclude-standard', '*.md']),
  ].filter(Boolean)
  // 不扫 out/ 和 video/（产物与渲染工程），但**不排除 examples/**
  return [...new Set(all)].filter(
    (f) => !/^(?:out|video)\//.test(f) && !f.includes('/node_modules/'),
  )
}

/* ────────────────────────── 路径解析 ────────────────────────── */

let trackedIndex = null
/** 基名 → 仓库内相对路径列表。用于解析文档里的简写（`pipeline3.js:3726`）。 */
function byBasename() {
  if (trackedIndex) return trackedIndex
  trackedIndex = new Map()
  // 这里原来有 `try { ... } catch {}`：出错就静默退回空索引。那个 catch 是错的 ——
  // 空索引会让所有 `pipeline3.js:3726` 这类简写引用解析失败，于是报出一份
  // 「文档引用全坏了」的结论，而真正的原因是枚举不到文件。
  // 现在交给 gitLines：环境问题退 2，不会伪装成「引用坏了」。
  const out = gitLines(['-c', 'core.quotepath=false', 'ls-files'], { root: ROOT })
  for (const f of out) {
    const b = basename(f)
    if (!trackedIndex.has(b)) trackedIndex.set(b, [])
    trackedIndex.get(b).push(f)
  }
  return trackedIndex
}

function resolveRef(docRel, refPath) {
  const norm = refPath.replace(/\\/g, '/')
  // 1. 从仓库根算（最常见的写法）
  const fromRoot = norm.replace(/^\.\//, '')
  if (existsSync(join(ROOT, fromRoot)) && !fromRoot.includes('..')) {
    return { abs: join(ROOT, fromRoot), rel: fromRoot, how: 'repo-root' }
  }
  // 2. 从文档自身目录算（`../scripts/x.js`）
  const fromDoc = resolve(join(ROOT, dirname(docRel)), norm)
  if (fromDoc.startsWith(ROOT) && existsSync(fromDoc)) {
    return { abs: fromDoc, rel: fromDoc.slice(ROOT.length + 1).replace(/\\/g, '/'), how: 'doc-relative' }
  }
  // 3. 文档里的简写：只给了基名（`pipeline3.js:3726`）。唯一匹配才算，
  //    歧义就报出来让人写全 —— 猜错了比不猜更糟。
  if (!norm.includes('/')) {
    const hits = byBasename().get(norm) || []
    if (hits.length === 1) {
      return { abs: join(ROOT, hits[0]), rel: hits[0], how: 'basename' }
    }
    if (hits.length > 1) {
      return { ambiguous: hits }
    }
  }
  // 4. 路径后缀匹配（`scripts/pipeline3.js` 简写成 `pipeline3.js` 之外的写法）
  const hits = [...byBasename().values()].flat().filter((f) => f.endsWith('/' + norm))
  if (hits.length === 1) return { abs: join(ROOT, hits[0]), rel: hits[0], how: 'suffix' }

  return null
}

/* ────────────────────────── 行号展开 ────────────────────────── */

function parseNumbers(spec) {
  const nums = []
  for (const part of spec.split(',')) {
    const m = part.match(/^(\d+)\s*[-–]\s*(\d+)$/)
    if (m) {
      const a = Number(m[1])
      const b = Number(m[2])
      for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) nums.push(i)
    } else if (part.trim()) {
      nums.push(Number(part.trim()))
    }
  }
  return nums.filter((n) => Number.isFinite(n) && n > 0)
}

/** 把一行压成可比较的形状：去掉首尾空白，内部连续空白折成一个空格。 */
function normLine(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
}

/**
 * 带内容锚点的引用：这一行还必须含锚点文字。
 * 锚点只跟**行号列表里的第一个数**比 —— 范围引用 `a-b` 的语义是「从 a 到 b」，
 * 锚点声明的是起始那片代码，要求端点 b 也含同一段文字会凭空造成假红。
 */
function anchorOk(lineText, anchor) {
  if (!anchor) return true
  return normLine(lineText).includes(normLine(anchor))
}

/** 范围的端点必须非空；范围内部允许空行（代码分段本来就是空行）。 */
function endpointNumbers(spec) {
  return spec
    .split(',')
    .flatMap((part) => {
      const m = part.match(/^(\d+)\s*[-–]\s*(\d+)$/)
      return m ? [Number(m[1]), Number(m[2])] : [Number(part.trim())]
    })
    .filter((n) => Number.isFinite(n) && n > 0)
}

/* ────────────────────────── 主流程 ────────────────────────── */

const lineCache = new Map()
function lines(abs) {
  if (!lineCache.has(abs)) {
    try {
      lineCache.set(abs, readFileSync(abs, 'utf8').split(/\r?\n/))
    } catch {
      lineCache.set(abs, null)
    }
  }
  return lineCache.get(abs)
}

const hard = [] // 发布文档里的问题 → FAIL
const soft = [] // 分析记录里的问题 → WARN
const resolvedVia = new Map()
const perDoc = []
let totalRefs = 0
let publishedRefs = 0
let anchoredRefs = 0 // 有几处引用真的带了内容锚点（其余只验到「非空」）

const docs = mdFiles()

for (const doc of docs) {
  let text
  try {
    text = readFileSync(join(ROOT, doc), 'utf8')
  } catch {
    continue
  }
  const pub = isPublished(doc)
  const sink = pub ? hard : soft
  REF_RE.lastIndex = 0
  let m
  let n = 0
  while ((m = REF_RE.exec(text))) {
    const refPath = m[1]
    const spec = m[2]
    n += 1
    totalRefs += 1
    if (pub) publishedRefs += 1

    const target = resolveRef(doc, refPath)
    if (!target) {
      sink.push({ doc, ref: `${refPath}:${spec}`, why: '引用的文件不存在' })
      continue
    }
    if (target.ambiguous) {
      sink.push({
        doc,
        ref: `${refPath}:${spec}`,
        why: `只写了文件名，仓库里有 ${target.ambiguous.length} 个同名文件 —— 写全路径`,
      })
      continue
    }
    resolvedVia.set(target.how, (resolvedVia.get(target.how) || 0) + 1)

    const L = lines(target.abs)
    if (!L) {
      sink.push({ doc, ref: `${refPath}:${spec}`, why: '文件读不出来' })
      continue
    }
    for (const num of parseNumbers(spec)) {
      if (num > L.length) {
        sink.push({ doc, ref: `${target.rel}:${num}`, why: `行号越界（文件只有 ${L.length} 行）` })
      }
    }
    for (const num of endpointNumbers(spec)) {
      if (num <= L.length && !L[num - 1].trim()) {
        sink.push({ doc, ref: `${target.rel}:${num}`, why: '端点那一行是空的' })
      }
    }
    // 【内容锚点】声明了锚点，就要求首个行号那一行真的还含这段文字。
    // 这是唯一能挡住「行号整体位移后落到另一个有意义的行上」的判据。
    const anchor = m[3]
    if (anchor) {
      anchoredRefs += 1
      const first = parseNumbers(spec)[0]
      if (first && first <= L.length && !anchorOk(L[first - 1], anchor)) {
        sink.push({
          doc,
          ref: `${target.rel}:${first}`,
          why: `锚点「${anchor}」已不在这一行（现在这行是「${normLine(L[first - 1]).slice(0, 60)}」）`,
        })
      }
    }
  }
  if (n) perDoc.push([doc, n, pub])
}

/* ────────────────────────── FAILURES.md 分类对账 ────────────────────────── */

const tallyProblems = []
{
  const doc = 'docs/FAILURES.md'
  const p = join(ROOT, doc)
  if (existsSync(p)) {
    const text = readFileSync(p, 'utf8')
    const order = ['真', '部分真', '假', '未证实']
    const m = text.match(/\*\*(\d+) 真 \/ (\d+) 部分真 \/ (\d+) 假 \/ (\d+) 未证实\*\*/)
    if (!m) {
      tallyProblems.push(`${doc} 找不到统计口径那一行`)
    } else {
      const claimed = order.map((_, i) => Number(m[i + 1]))
      // 【只对账「结论速览」那一张表】
      // 原来的判据是全文 `^| 数字 |`，于是**任何**编号表格都会被当成速览表。
      // 实测 2026-11-26T16:2x：往 FAILURES.md 里加一条 7 行的耗时表（列是
      // 变体/state/ms/linesAdded，与分类无关），闸门立刻报 8 处红 ——
      // 6 处「表格里状态「margin+ground+pours+keep」不在四类里」，
      // 外加「口径四项相加=15，但表格有 22 行」。
      // 那等于禁止这份文档再增加任何编号表格，哪怕它是本次测量最硬的证据。
      // 收窄到小节内；小节内的判据一条不放宽。
      const secStart = text.search(/^##\s*结论速览\s*$/m)
      let secText = text
      if (secStart >= 0) {
        const after = text.slice(secStart + 1)
        const secEnd = after.search(/^##\s/m)
        secText = secEnd >= 0 ? after.slice(0, secEnd) : after
      }
      const rows = secText.split(/\r?\n/).filter((l) => /^\|\s*\d+\s*\|/.test(l))
      const seen = Object.fromEntries(order.map((k) => [k, 0]))
      for (const r of rows) {
        const cell = (r.match(/^\|\s*\d+\s*\|\s*([^|]+?)\s*\|/) || [])[1]
        if (cell === undefined) continue
        const s = cell.replace(/\*/g, '').trim()
        if (s in seen) seen[s] += 1
        else tallyProblems.push(`${doc} 表格里状态「${s}」不在四类里`)
      }
      order.forEach((k, i) => {
        if (seen[k] !== claimed[i]) {
          tallyProblems.push(`${doc} 口径说 ${k}=${claimed[i]}，表格实际 ${seen[k]}`)
        }
      })
      const sum = claimed.reduce((a, b) => a + b, 0)
      if (rows.length !== sum) {
        tallyProblems.push(`${doc} 口径四项相加=${sum}，但表格有 ${rows.length} 行`)
      }
    }
  }
}

/* ────────────────────────── 自检：闸门自己坏没坏 ────────────────────────── */

const selfProblems = []
{
  const SAMPLE = 'scripts/pipeline3.js:1651,1686'
  REF_RE.lastIndex = 0
  const st = REF_RE.exec(SAMPLE)
  if (!st || st[1] !== 'scripts/pipeline3.js' || st[2] !== '1651,1686') {
    selfProblems.push(`引用正则匹配不上已知样本 ${SAMPLE} —— 闸门自己坏了，不是文档坏了`)
  }
  // 中文文件名必须能整段识别，不能被截成后半截再去核另一个文件
  const CJK = '交付-README.md:44-45'
  REF_RE.lastIndex = 0
  const cj = REF_RE.exec(CJK)
  if (!cj || cj[1] !== '交付-README.md') {
    selfProblems.push(`中文文件名识别不对：${CJK} 被读成 ${cj ? cj[1] : '（没匹配上）'}`)
  }
  // 【锚点判据必须能失败】只在真文档上跑一遍不算验证：万一某天所有锚点都恰好命中，
  // 一个永远返回 true 的 anchorOk 也会全绿。这里两个方向都钉住。
  if (anchorOk('  const MAX_ROUTE_ITERS = 4;   // 上限', 'const MAX_ROUTE_ITERS = 4;') !== true) {
    selfProblems.push('锚点判据在**该命中**时没命中 —— 闸门自己坏了')
  }
  if (anchorOk('  const MAX_ROUTE_ITERS = 6;', 'const MAX_ROUTE_ITERS = 4;') !== false) {
    selfProblems.push('锚点判据在**不该命中**时命中了 —— 判据形同虚设')
  }
  if (anchorOk('  a  b   c', 'a b c') !== true) {
    selfProblems.push('锚点判据不忽略空白差异 —— 会制造假红')
  }
  // 带锚点的引用串必须被解析出 group 3，否则上面整段检验根本不会被走到。
  {
    const WITH = 'scripts/pipeline3.js:1499 "const MAX_ROUTE_ITERS = 4;"'
    REF_RE.lastIndex = 0
    const w = REF_RE.exec(WITH)
    if (!w || w[3] !== 'const MAX_ROUTE_ITERS = 4;' || w[2] !== '1499') {
      selfProblems.push(`带锚点的引用解析不出来：${WITH} -> ${JSON.stringify(w && [w[1], w[2], w[3]])}`)
    }
    // 不带锚点的引用不能因为正则改动而多出 group 3
    REF_RE.lastIndex = 0
    const wo = REF_RE.exec('scripts/pipeline3.js:1499')
    if (!wo || wo[3] !== undefined) {
      selfProblems.push('不带锚点的引用被解析出了锚点 —— 正则会误吃正文里的引号')
    }
  }
  if (totalRefs === 0) {
    selfProblems.push('0 处引用。这不是「全部通过」，是没有样本 —— 扫描范围或正则坏了')
  }
  if (publishedRefs === 0) {
    selfProblems.push('发布文档里 0 处引用。`docs/FAILURES.md` 明确有很多处，说明文件发现环节坏了')
  }
}

/* ────────────────────────── 报告 ────────────────────────── */

console.log('  ── 文档引用 ──')
for (const [doc, n, pub] of perDoc) {
  console.log(`  ${String(n).padStart(4)} 处  ${pub ? '发布' : '记录'}  ${doc}`)
}
console.log(
  `  ${'合计'.padStart(4)}  ${totalRefs} 处，其中发布文档 ${publishedRefs} 处；`
  + `解析方式 ${[...resolvedVia].map(([k, v]) => `${k}×${v}`).join(' / ')}`,
)

const section = (title, list) => {
  if (!list.length) return
  console.log(`\n  ── ${title} ──`)
  for (const b of list) console.log(`  ✗ ${b.doc} → ${b.ref}  ${b.why}`)
}
section('烂引用（发布文档，必须修）', hard)
section('烂引用（分析记录，历史事实，不拦提交）', soft)
section('分类对账', tallyProblems.map((p) => ({ doc: 'docs/FAILURES.md', ref: '—', why: p })))
section('闸门自身问题', selfProblems.map((s) => ({ doc: '(self)', ref: '—', why: s })))

if (!hard.length && !tallyProblems.length && !selfProblems.length) {
  console.log(
    `\n  ✓ 发布文档的 ${publishedRefs} 处引用全部指到非空的行`
    + `（其中 ${anchoredRefs} 处还核对了内容锚点，其余只验到「非空」），分类与计数一致`
    + (soft.length ? `（另有 ${soft.length} 处分析记录里的历史引用已腐烂，不影响提交）` : ''),
  )
}

const bad = hard.length + tallyProblems.length + selfProblems.length
console.log(
  `\n  ${
    bad
      ? `DOCREFS=FAIL  发布文档 ${hard.length} 处 + 对账 ${tallyProblems.length} 处 + 闸门自身 ${selfProblems.length} 处`
      : `DOCREFS=PASS  发布文档 ${publishedRefs} 处引用有效`
        + `（${anchoredRefs} 处核对了内容锚点）`
        + (soft.length ? `；分析记录 ${soft.length} 处历史引用已腐烂（WARN）` : '')
  }`,
)
process.exit(bad ? 1 : 0)
