#!/usr/bin/env node
/**
 * 能力分级闸门：把 `capabilities.json` 里的「这条能力我们实测过没有」变成一条会红的检查。
 *
 * ## 为什么需要
 *
 * 这个仓库最贵的一次事故不是某个 API 用错，而是**一条从未被验证过的前提被当成了已验证**：
 * 「自动布线期间画布会实时更新」。23 张布线阶段的截图因此被拼进视频，假装它们记录了
 * 布线过程。事后实测 `out/frames/REAL_143856` 里 23 张 `*route*` 帧，22 对差分**0 对**
 * 超过 0.02（`scripts/desktop-diff.ps1`，测于 2026-11-26T15:39:38+08:00），真实原因是
 * `startAutoRouting` 是作业模型，几何在 `completed` 时才一次性提交。
 *
 * 仓库里本来就有三份**散文式**的核实表（`docs/REVERSE-NOTES.md` 的 EPCB_LayerId 表、
 * `api/` 下 108 个 JSON 的 `visibility`、`scripts/CANVAS-API-RCA.md` 的「待证实」清单），
 * 但没有一行代码读它们，所以它们拦不住任何人。这个闸门就是把其中一条变成可执行的：
 * **未验证的能力，不许出现在无人值守的依赖链上。**
 *
 * ## 三条检查
 *
 * - **A** `level ∈ {not_verified, not_implemented}` 且 `unattended: true` → FAIL（退出 1）。
 *   错误消息点名 id 与 call_sites —— 只说「配置有问题」等于没说。
 * - **B** `level: "verified"` 的条目必须有非空 evidence，且每个路径（去掉 `#L...` 锚点）
 *   在仓库里真实存在。`verified` 的意思是可核对，不是「作者说验过」。
 * - **C** 空表 / 缺字段 / JSON 坏 / 文件不存在 → 退出 **2**，不是 0。
 *   0 条不是「全部通过」，是「没有样本」（与 `dirs: 0` 读成 100% 同一类错误）。
 *
 * ## 退出码（与 test/ 下三个闸门同一契约）
 *
 *   0 = 全部检查通过
 *   1 = **发现了失败**（这是一个结论）
 *   2 = 没能测量（文件不存在 / JSON 坏 / 表为空 / 未知 level / unattended 不是布尔）
 *
 * 2 与 1 的处置完全相反：1 是「去修能力声明或代码」，2 是「去修输入」。曾经三个闸门
 * 把「git 不在 PATH」崩成 1，CI 上没人分得清「我的代码有语法错误」和「这台 runner
 * 没装 git」—— 见 `test/_git.mjs` 的注释。这里不重复那个错误。
 *
 * ## 为什么 level 与 API 的 `visibility` 无关
 *
 * `api/` 里 `pcb_*` 几乎全是 `visibility: beta`。若把 beta 当 not_verified，闸门上线
 * 当天就红一片，第二天就会有人加 `|| true`，闸门报废。所以 `level` 只回答
 * 「本仓库实测过没有」，与官方成熟度是两套坐标。这条写进了 `capabilities.json`
 * 的 `_readme`，因为**文件的内容**才是机制，闸门只是它的执行器。
 *
 * ## 不做什么
 *
 * 不联网、不写文件、不改 `capabilities.json`。它只读一个输入、给一个判决。
 *
 * ## 用法
 *
 *   node test/capability-gate.mjs            # 人类可读，末尾一行带分母的汇总
 *   node test/capability-gate.mjs --json     # 结构化（summary 字段里是同一行汇总）
 *
 * @module pcb-auto/test/capability-gate
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REL = 'capabilities.json'
const FILE = join(ROOT, REL)

/** 四种 level。policy.levels 可以覆盖/扩展，但它没写时按这四个算。 */
const DEFAULT_LEVELS = ['verified', 'pilot', 'not_verified', 'not_implemented']
/** 这些 level 不许被 unattended:true 的能力使用。 */
const BLOCKING = new Set(['not_verified', 'not_implemented'])
/** 输出里 level 的固定顺序（只影响可读性，不影响判决）。 */
const LEVEL_ORDER = [...DEFAULT_LEVELS]

const ARGS = process.argv.slice(2)
const JSON_OUT = ARGS.includes('--json')

if (ARGS.includes('--help') || ARGS.includes('-h')) {
  process.stdout.write(
    '用法: node test/capability-gate.mjs [--json]\n'
    + '  读仓库根的 capabilities.json，检查三条：\n'
    + '  A 未验证能力不得被无人值守依赖（level = not_verified/not_implemented 且 unattended:true）\n'
    + '  B verified 必须有非空且真实存在的 evidence\n'
    + '  C 空表 / 缺字段 / JSON 坏 / 文件缺失 = 退出 2（没能测量，不是通过）\n'
    + '退出码: 0 通过 / 1 发现了失败 / 2 没能测量\n',
  )
  process.exit(0)
}

const unknownArgs = ARGS.filter((a) => a !== '--json')
if (unknownArgs.length) {
  // 未知参数是「输入给错了」，不是「能力有问题」——归 2。
  console.error(`\n  [env] 未知参数：${unknownArgs.join(' ')}`)
  console.error('  本闸门只接受 --json 与 --help。')
  process.exit(2)
}

/* ────────────────────────── 输出：没能测量 ────────────────────────── */

/**
 * 退出 2。**不是**「发现了失败」。
 * @param {string} reason 一句话说清哪种输入问题
 * @param {string} [detail] 补充（JSON.parse 的原文、字段形状等）
 */
function envExit(reason, detail) {
  const summary = `CAPABILITY=UNMEASURED 0 条（没能测量：${reason}）`
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({
      tool: 'capability-gate',
      ok: false,
      exit: 2,
      file: REL,
      measured: false,
      reason,
      detail: detail || null,
      summary,
    }, null, 2) + '\n')
  } else {
    const out = []
    out.push(`\n  [env] ${reason}`)
    if (detail) out.push(`  [env] ${detail}`)
    out.push('  退出码 2 = 没能测量（文件/输入问题），不是「发现了失败」。')
    out.push('')
    out.push(`  ${summary}`)
    process.stdout.write(out.join('\n') + '\n')
  }
  process.exit(2)
}

/* ────────────────────────── 读 + 解析 ────────────────────────── */

let raw
try {
  raw = readFileSync(FILE, 'utf8')
} catch (e) {
  envExit(`${REL} 读不出来`, e && e.message ? String(e.message).split('\n')[0] : '')
}

let doc
try {
  doc = JSON.parse(raw)
} catch (e) {
  // JSON 坏 = 表本身坏了。绝不能退回空表让它「通过」——
  // 空表会让下游报出一份「全部通过」，而真正的原因是没有输入。
  envExit(`${REL} 不是合法 JSON`, e && e.message ? String(e.message).split('\n')[0] : '')
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

if (!isPlainObject(doc)) envExit(`${REL} 顶层不是对象`, `读到的是 ${Array.isArray(doc) ? '数组' : typeof doc}`)
if (!('capabilities' in doc)) envExit(`${REL} 缺少 capabilities 字段`, '这个字段缺失时，「全部通过」和「没有样本」分不开')
if (!Array.isArray(doc.capabilities)) {
  envExit(`${REL} 的 capabilities 不是数组`, `读到的是 ${typeof doc.capabilities}`)
}
if (doc.capabilities.length === 0) {
  // 0 条不是「全部通过」，是没有样本。与 `dirs: 0 读成 100%` 同一类错误。
  envExit(`${REL} 的 capabilities 是空数组`, '0 条不是「全部通过」，是没有样本 —— 检查生成/拷贝是否真的发生了')
}

/* ────────────────────────── 合法 level 集合 ────────────────────────── */

let allowed = new Set(DEFAULT_LEVELS)
if (isPlainObject(doc.policy) && isPlainObject(doc.policy.levels)) {
  const keys = Object.keys(doc.policy.levels).filter((k) => typeof doc.policy.levels[k] === 'string')
  if (keys.length) allowed = new Set(keys)
}

/* ────────────────────────── 表结构校验（坏表 → 2） ────────────────────────── */

const caps = doc.capabilities
const seen = new Set()
const entries = []

for (let i = 0; i < caps.length; i += 1) {
  const c = caps[i]
  if (!isPlainObject(c)) envExit(`capabilities[${i}] 不是对象`, `读到的是 ${Array.isArray(c) ? '数组' : typeof c}`)

  const id = typeof c.id === 'string' ? c.id.trim() : ''
  if (!id) envExit(`capabilities[${i}] 缺少 id`, '每条能力都必须有稳定的 id，否则报错无法点名')
  if (seen.has(id)) envExit(`能力 id 重复：${id}`, '同一个 id 出现两次时，任何「按 id 看结论」的读法都是错的')
  seen.add(id)

  if (typeof c.level !== 'string' || !allowed.has(c.level)) {
    // 未知 level 不是「能力有问题」，是表写坏了 —— 2。
    envExit(
      `能力 ${id} 的 level=${JSON.stringify(c.level)} 不认识`,
      `合法值：${[...allowed].join(' / ')}`,
    )
  }

  // unattended 必须是布尔。字符串 "false" 是真值 —— 这会静默放行一条未验证能力。
  if (typeof c.unattended !== 'boolean') {
    envExit(
      `能力 ${id} 的 unattended=${JSON.stringify(c.unattended)} 不是布尔`,
      'unattended 必须是 true / false。字符串 "false" 在 JS 里是真值，会让 A 检查静默失效',
    )
  }

  if (c.evidence !== undefined && !Array.isArray(c.evidence)) {
    envExit(`能力 ${id} 的 evidence 不是数组`, `读到的是 ${typeof c.evidence}`)
  }
  if (c.call_sites !== undefined && !Array.isArray(c.call_sites)) {
    envExit(`能力 ${id} 的 call_sites 不是数组`, `读到的是 ${typeof c.call_sites}`)
  }

  entries.push({
    id,
    level: c.level,
    unattended: c.unattended,
    evidence: Array.isArray(c.evidence) ? c.evidence : null,
    call_sites: Array.isArray(c.call_sites) ? c.call_sites.map((s) => String(s)) : [],
  })
}

/* ────────────────────────── A / B 检查 ────────────────────────── */

/** @type {{check:'A'|'B', id:string, why:string}[]} */
const problems = []

const aCount = { checked: 0, red: 0 }
for (const e of entries) {
  if (!BLOCKING.has(e.level)) continue
  aCount.checked += 1
  if (e.unattended !== true) continue
  aCount.red += 1
  problems.push({
    check: 'A',
    id: e.id,
    why: `level=${e.level} 但 unattended=true；无人值守路径不得依赖未验证能力`
      + `（call_sites: ${e.call_sites.length ? e.call_sites.join(', ') : '未填'}）`,
  })
}

const bCount = { verified: 0, paths: 0, red: 0 }
for (const e of entries) {
  if (e.level !== 'verified') continue
  bCount.verified += 1

  if (!e.evidence || e.evidence.length === 0) {
    bCount.red += 1
    problems.push({ check: 'B', id: e.id, why: 'verified 但 evidence 为空 —— 没有可核对的证据' })
    continue
  }

  for (const rawPath of e.evidence) {
    if (typeof rawPath !== 'string' || !rawPath.trim()) {
      bCount.red += 1
      problems.push({ check: 'B', id: e.id, why: `evidence 里有非字符串/空条目：${JSON.stringify(rawPath)}` })
      continue
    }
    // 锚点只供人读：`scripts/pipeline3.js#L175-L195` 的 `#L...` 不参与存在性核对。
    const rel = rawPath.split('#')[0].trim().replace(/\\/g, '/')
    const isAbsolute = rel.startsWith('/') || /^[A-Za-z]:/.test(rel)
    const escapes = rel.split('/').includes('..')

    if (!rel || isAbsolute || escapes) {
      bCount.red += 1
      problems.push({
        check: 'B',
        id: e.id,
        why: `evidence 必须是仓库内相对路径（不许绝对路径或 ..）：${rawPath}`,
      })
      continue
    }

    bCount.paths += 1
    if (!existsSync(join(ROOT, rel))) {
      bCount.red += 1
      problems.push({ check: 'B', id: e.id, why: `evidence 指向的路径在仓库里不存在：${rel}` })
    }
  }
}

/* ────────────────────────── 统计 + 输出 ────────────────────────── */

const counts = {}
for (const l of LEVEL_ORDER) counts[l] = 0
for (const e of entries) counts[e.level] = (counts[e.level] || 0) + 1

const total = entries.length
const dist = Object.entries(counts)
  .filter(([, n]) => n > 0)
  .map(([l, n]) => `${l} ${n}`)
  .join(' / ')

const exitCode = problems.length ? 1 : 0
const summary = problems.length
  ? `CAPABILITY=FAIL ${problems.length} 个问题 / ${total} 条`
  : `CAPABILITY=PASS ${total} 条（${dist}）`

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({
    tool: 'capability-gate',
    ok: problems.length === 0,
    exit: exitCode,
    file: REL,
    measured: true,
    total,
    levels: counts,
    unattended: entries.filter((e) => e.unattended === true).length,
    checks: {
      A: { checked: aCount.checked, problems: aCount.red, rule: 'level ∈ {not_verified, not_implemented} 不得 unattended=true' },
      B: { verified: bCount.verified, evidencePathsChecked: bCount.paths, problems: bCount.red, rule: 'verified 的 evidence 非空且路径存在' },
      C: { emptyTable: false, problems: 0, rule: '空表/缺字段/JSON 坏 = 退出 2' },
    },
    problems,
    summary,
  }, null, 2) + '\n')
  process.exit(exitCode)
}

/* 人类可读 */
const lines = []
lines.push('')
lines.push('  ── 能力分级闸门（capabilities.json）──')
lines.push(`  ${total} 条能力，其中 unattended:true 的 ${entries.filter((e) => e.unattended === true).length} 条`)
for (const e of entries) {
  const flag = e.unattended ? 'unattended' : '  —       '
  const sites = e.call_sites.length ? `  ← ${e.call_sites.join(', ')}` : ''
  lines.push(`    ${e.level.padEnd(15)} ${flag}  ${e.id}${sites}`)
}
lines.push('')
lines.push(`  A 未验证能力不得被无人值守依赖：${aCount.red ? `RED（${aCount.red} 条违规）` : `GREEN（${aCount.checked} 条未验证能力都不是 unattended）`}`)
lines.push(`  B verified 必须有存在的证据：${bCount.red ? `RED（${bCount.red} 处问题）` : `GREEN（${bCount.verified} 条 verified / ${bCount.paths} 个 evidence 路径都存在）`}`)
lines.push(`  C 不许空表：GREEN（${total} 条，非空）`)

if (problems.length) {
  lines.push('')
  lines.push('  ── 失败 ──')
  for (const p of problems) lines.push(`  ✗ [${p.check}] ${p.id}  ${p.why}`)
}
lines.push('')
lines.push(`  ${summary}`)

process.stdout.write(lines.join('\n') + '\n')
process.exit(exitCode)
