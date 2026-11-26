#!/usr/bin/env node
/**
 * pcb-auto · 通用 CLI
 *
 * 任何一个能执行 shell 的 Agent 都能用这个，不需要 MCP、不需要插件、不需要 SDK。
 * 输出默认是单行 JSON（stdout），日志走 stderr —— 这样 `pcb fabcheck | jq` 永远可用。
 *
 * 用法：
 *   pcb list
 *   pcb fabcheck out/d1
 *   pcb census --settle 180
 *   pcb idea-to-design "做一个 SHT30 温湿度采集板" --dry
 *   pcb build designs/d1.json
 *   pcb verify --skipCensus
 *
 * 退出码语义（稳定契约，可被脚本依赖）：
 *   0  成功 / 可下单 / 判定通过
 *   1  判定结果为「否」（不可下单、流水线失败、校验失败）—— **这是结果，不是错误**
 *   2  调用错误（参数缺失、路径不存在、环境不对）
 */

import { OPS, dispatch, ROOT } from '../core/ops.mjs'

const argv = process.argv.slice(2)

/** 极简参数解析：--key=value / --key value / --flag，外加按声明顺序绑定的位置参数。 */
function parseArgs(argvList, spec) {
  const out = {}
  const positional = []
  // 不认识的 `--flag` 必须单独收集，**绝不能**当成位置参数。
  //
  // 以前它是 `positional.push(a)`：于是 `pcb build x --dry` 里的 `--dry` 会被
  // 下面那段「按声明顺序填空」的逻辑吃掉，变成 build 的下一个参数的**值**。
  // 实测后果：`--dry` 落进 `allowPartial`，成了真值 → 静默打开 allowPartial。
  // 用户以为自己要了一次试跑，实际拿到的是十分钟真构建 + 语义被改过。
  // 一个拼错的开关不该同时「被忽略」和「改变行为」，更不该不报错。
  const unknown = []
  for (let i = 0; i < argvList.length; i++) {
    const a = argvList[i]
    if (!a.startsWith('--')) { positional.push(a); continue }
    let key = a.slice(2)
    let val
    const eq = key.indexOf('=')
    if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq) }
    const def = spec[key]
    if (!def) { unknown.push(a); continue }
    if (def.type === 'boolean') {
      out[key] = val === undefined ? true : !/^(false|0|no)$/i.test(val)
    } else if (def.type === 'integer') {
      out[key] = Number(val === undefined ? argvList[++i] : val)
    } else {
      out[key] = val === undefined ? argvList[++i] : val
    }
  }
  // 位置参数按声明顺序填进还没给值的键：`pcb fabcheck out/d1` 等价于 `--dir out/d1`
  const order = Object.keys(spec)
  let k = 0
  for (const p of positional) {
    while (k < order.length && out[order[k]] !== undefined) k++
    if (k >= order.length) break
    const key = order[k]
    out[key] = spec[key].type === 'integer' ? Number(p) : spec[key].type === 'boolean' ? p === 'true' : p
    k++
  }
  return { out, unknown: unknown.concat(positional.slice(order.length)) }
}

function usage() {
  const lines = [
    'pcb-auto · 自然语言想法 → 可下单 PCB',
    '',
    '用法： pcb <操作> [参数…] [--human]',
    '',
    '操作：',
  ]
  for (const [name, op] of Object.entries(OPS)) {
    lines.push(`  ${name.padEnd(16)} ${op.summary}`)
    for (const [k, v] of Object.entries(op.args)) {
      lines.push(`      --${(k + (v.required ? '*' : '')).padEnd(14)} ${v.description || v.type}`)
    }
  }
  lines.push('', `仓库根：${ROOT}`, '(可用环境变量 PCB_AUTO_ROOT 覆盖)', '',
    '退出码：0 通过 / 1 判定为否（结果，非错误）/ 2 调用错误')
  return lines.join('\n')
}

/** 把结果渲染成给人看的一行或几行。 */
function human(opName, r) {
  switch (opName) {
    case 'idea-to-design':
      return r.ok
        ? `设计 ${r.complexity}：${r.components} 器件 / ${r.connections} 连接 / ${r.nets} 网络` +
          (r.path ? `\n  已写入 ${r.path}` : '\n  (dry，未写盘)') + `\n  网络 ${r.netsList}\n  ${r.parts}`
        : `编译被拒绝：\n${r.reason}`
    case 'build':
      return `${r.ok ? 'PASS' : 'FAIL'}  ${r.designName || '?'}  ${r.elapsedSec ?? '?'}s` +
        `\n  DRC ${r.drcPassed ? '通过' : '未通过'}（${r.drcViolations} 条）  导出 ${r.exportsOk}/${r.exportsTotal}` +
        `\n  → ${r.runDir || '(未找到产物目录)'}` + (r.ok ? '' : `\n\n${r.detail || ''}`)
    case 'fabcheck':
      return r.orderable
        ? `可下单  ${r.dir}（0 阻断 / ${r.warn ?? r.warningCount} 警告）`
        : `不可下单  ${r.dir}（${r.blockerCount} 阻断 / ${r.warningCount} 警告）\n${(r.blockers || r.raw || '')}`
    case 'census':
      return `普查（${r.at}）：${r.dirs} 目录 → 可打样 ${r.fabOk} / 有阻断 ${r.blocked} / 解析错 ${r.parseErrors}` +
        (r.inFlight ? `（在飞跳过 ${r.inFlight}）` : '') +
        (r.selfOkTrue ? `\n  自述 ok=true：${r.selfOkTrueOk}/${r.selfOkTrue}` : '') +
        (r.blockerIds ? `\n  阻断类型：${r.blockerIds}` : '')
    case 'verify':
      return `${r.verdict}  PASS ${r.pass} / INFO ${r.info} / WARN ${r.warn} / FAIL ${r.fail} / ERROR ${r.error}` +
        (r.failures ? `\n${r.failures}` : '')
    default:
      return JSON.stringify(r, null, 2)
  }
}

const opName = argv.find((a) => !a.startsWith('-'))

// 「看帮助」和「调用错误」是两件事。
// 以前 `pcb --help` 退出 2 —— 理由是「没给操作名」。但在脚本和 CI 里
// `pcb --help || exit 1`、`pcb --help >/dev/null || fail` 都把它当成坏掉了，
// 而它其实完全成功了。所以：要帮助 = 成功；什么都不给 = 调用错误。
const wantsHelp = argv.includes('--help') || argv.includes('-h') || opName === 'help'

if (wantsHelp || !opName) {
  console.log(usage())
  process.exit(wantsHelp ? 0 : 2)
}

if (opName === 'list') {
  // `list` 不接受任何参数。以前它直接忽略，于是 `pcb list --whatever` 退出 0 ——
  // 唯一一个「未知开关不报错」的例外。例外会让规则变成建议。
  const extraList = argv.slice(argv.indexOf(opName) + 1).filter((a) => a !== '--human')
  if (extraList.length) {
    process.stderr.write(`list 不接受参数，但收到：${extraList.join(' ')}\n`)
    process.stdout.write(JSON.stringify({ ok: false, exitCode: 2, op: 'list', unknownArgs: extraList, reason: `list 不接受参数：${extraList.join(' ')}` }) + '\n')
    process.exit(2)
  }
  const table = Object.entries(OPS).map(([n, o]) => ({
    name: n,
    summary: o.summary,
    summaryEn: o.summaryEn,
    args: Object.fromEntries(Object.entries(o.args).map(([k, v]) => [k, {
      type: v.type, required: Boolean(v.required), description: v.description,
    }])),
  }))
  console.log(JSON.stringify({ ok: true, root: ROOT, ops: table }, null, 2))
  process.exit(0)
}

if (!OPS[opName]) {
  process.stderr.write(`未知操作：${opName}\n\n${usage()}\n`)
  process.exit(2)
}

// 全局开关先摘掉，再解析操作参数，否则 --human 会被当成位置参数
const GLOBAL_FLAGS = new Set(['--human'])
const rest = argv.slice(argv.indexOf(opName) + 1).filter((a) => !GLOBAL_FLAGS.has(a))
const { out, unknown } = parseArgs(rest, OPS[opName].args)
if (unknown.length) {
  // 调用错误 ⇒ 退出码 2，和不存在的操作同等对待。
  //
  // 这里以前是 `[warn] 忽略了不认识的参数` 然后**继续跑**。对一个要跑 2–20 分钟、
  // 要写盘、要占 EDA 进程的操作来说，这是最坏的一种「宽容」：用户以为传了个
  // 开关，实际什么都没发生，而命令已经开工了。别把「我没看懂你的参数」降级成警告。
  const mine = Object.keys(OPS[opName].args)
  const msg = []
  msg.push(`不认识的参数：${unknown.join(' ')}`)
  // 这些开关在别的操作里存在 —— 直接说明，比让用户去翻 --help 快。
  for (const u of unknown) {
    const k = u.replace(/^--/, '').split('=')[0]
    const owners = Object.entries(OPS).filter(([n, o]) => n !== opName && o.args[k]).map(([n]) => n)
    if (owners.length) msg.push(`  ${u} 是 ${owners.join(' / ')} 的参数，${opName} 不支持`)
  }
  msg.push(`  ${opName} 支持的参数：${mine.length ? mine.map((k) => '--' + k).join(' ') : '（无，只接受位置参数）'}`)
  process.stderr.write(msg.join('\n') + '\n')
  process.stdout.write(JSON.stringify({ ok: false, exitCode: 2, op: opName, unknownArgs: unknown, reason: `不认识的参数：${unknown.join(' ')}` }) + '\n')
  process.exit(2)
}

const wantHuman = argv.includes('--human')

try {
  const result = await dispatch(opName, out, { root: ROOT })
  if (wantHuman) process.stdout.write(human(opName, result) + '\n')
  else process.stdout.write(JSON.stringify(result) + '\n')
  const code = Number.isInteger(result.exitCode) ? result.exitCode : (result.ok === false ? 1 : 0)
  process.exit(code)
} catch (e) {
  process.stderr.write(`[error] ${e && e.message ? e.message : e}\n`)
  process.stdout.write(JSON.stringify({ ok: false, exitCode: 2, error: String(e && e.message ? e.message : e) }) + '\n')
  process.exit(2)
}
