/**
 * pcb-auto · 唯一的一层实现
 *
 * 五个操作，纯 async 函数，不依赖任何框架、协议或 SDK。
 * CLI / MCP / DSH 插件都是这一层的薄壳 —— 一层实现，三种外壳。
 *
 * 为什么用 `.mjs`：仓库根的 package.json 没有 `"type": "module"`（因为 `scripts/*.js` 全是
 * CommonJS，改了会让 254 个脚本同时失效）。`.mjs` 扩展名让本文件在任何宿主里都是 ESM。
 *
 * @module pcb-auto/core
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 仓库根：core/ 的上一级。`PCB_AUTO_ROOT` 可以覆盖。 */
export const ROOT = resolve(process.env.PCB_AUTO_ROOT || join(HERE, '..'))

const CAP = 48 * 1024
const DEFAULT_TIMEOUT = 45 * 60 * 1000

/** 当前时间戳，ISO 8601 本地时区。所有输出都带它 —— 一个没有时刻的数字不是记录。 */
const now = () => new Date().toISOString()

/**
 * 跑一个子进程，捕获有界输出。
 * 非零退出码是**数据**，不是异常 —— 上层必须能读到它。
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?: string, signal?: AbortSignal, timeoutMs?: number}} [opts]
 * @returns {Promise<{code: number|null, out: string, err: string, timedOut: boolean, aborted: boolean}>}
 */
function run(cmd, args, opts = {}) {
  return new Promise((settle) => {
    const signals = []
    if (opts.signal) signals.push(opts.signal)
    if (opts.timeoutMs) signals.push(AbortSignal.timeout(opts.timeoutMs))
    const signal = signals.length ? AbortSignal.any(signals) : undefined

    let out = ''
    let err = ''
    let timedOut = false
    let aborted = false
    let done = false

    const child = spawn(cmd, args, {
      cwd: opts.cwd || ROOT,
      signal,
      windowsHide: true,
      env: {
        ...process.env,
        NO_COLOR: '1',
        // Windows 上 Python 打管道默认用本地代码页（英文系统 cp1252 / 中文 cp936）。
        // cp1252 编码不了中文，脚本会抛 UnicodeEncodeError 崩在中途 ——
        // 于是「一行中文摘要」这件事本身让整个量具返回非 0。
        // 中文 Windows 上永远复现不了（cp936 能编码中文），只在别人的 CI 上炸。
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const push = (buf, add) => (buf.length < CAP ? buf + add : buf)
    child.stdout.on('data', (d) => { out = push(out, d.toString('utf8')) })
    child.stderr.on('data', (d) => { err = push(err, d.toString('utf8')) })

    const finish = (code) => { if (!done) { done = true; settle({ code, out, err, timedOut, aborted }) } }

    child.on('error', (e) => {
      if (e && e.name === 'AbortError') {
        if (opts.timeoutMs && signal && signal.aborted && opts.signal && !opts.signal.aborted) timedOut = true
        else aborted = true
      } else {
        err = push(err, String(e && e.message ? e.message : e))
      }
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}

/** @param {string} s @param {number} n */
export const tail = (s, n) => (s.length <= n ? s : '…(已截断 ' + (s.length - n) + ' 字符)\n' + s.slice(-n))

/** Node 解释器：默认就是跑本文件的这个。 */
export const nodeBin = () => process.env.PCB_AUTO_NODE || process.execPath

/** PowerShell 宿主。 */
export const pwshBin = () => process.env.PCB_AUTO_PWSH || 'pwsh'

/**
 * 找一个能用的 Python。优先 DSH 自带 runtime，其次 PATH。
 * @returns {string}
 */
export function pythonBin() {
  if (process.env.PCB_AUTO_PYTHON) return process.env.PCB_AUTO_PYTHON
  const c = join(process.env.USERPROFILE || '', '.dsh', 'dsh-runtimes',
    'dsh-primary-runtime', 'dependencies', 'python', 'python.exe')
  return existsSync(c) ? c : 'python'
}

/**
 * 读 `.pipeline.lock`（仓库根的 key=value 文本）。
 * 只比时间戳，**绝不**探测 pid 存活 —— Windows CPython 里 `os.kill(pid, 0)` 是
 * `TerminateProcess(handle, 0)`，会真的把持有锁的进程杀掉。一个只读工具不能杀人。
 * @returns {{pid: string, design: string, start: string, startEpoch: number|null}|null}
 */
export function readLock(root = ROOT) {
  const p = join(root, '.pipeline.lock')
  if (!existsSync(p)) return null
  try {
    const kv = {}
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const i = line.indexOf('=')
      if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
    const e = kv.start ? Date.parse(kv.start) : NaN
    return { pid: kv.pid || '?', design: kv.design || '?', start: kv.start || '?', startEpoch: Number.isFinite(e) ? e / 1000 : null }
  } catch {
    return null
  }
}

/** @param {string} p */
function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

/**
 * 文件 mtime（毫秒 epoch），读不到返回 null。
 *
 * 存在的唯一理由是回答「这份报告是刚刚算出来的，还是本来就躺在那儿」。
 * 量具跑完之后 mtime 没变 ⇒ 它没写文件 ⇒ 读到的是旧数据。
 *
 * @param {string} p
 * @returns {number|null}
 */
function fileMtime(p) {
  try { return statSync(p).mtimeMs } catch { return null }
}

/**
 * 找某个设计名最新的一次产物目录。
 * @param {string} root
 * @param {string} designName
 * @returns {string|null}
 */
function newestRunDir(root, designName) {
  const outDir = join(root, 'out')
  if (!existsSync(outDir)) return null
  let best = null
  let bestM = 0
  for (const entry of readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(designName + '-')) continue
    const m = statSync(join(outDir, entry.name)).mtimeMs
    if (m > bestM) { bestM = m; best = join(outDir, entry.name) }
  }
  return best
}

/**
 * `out/` 下带 `_run.json` 的产物目录数 —— 也就是「本机语料有多大」。
 *
 * 单独一个函数是因为 `census` 必须能回答「**我的**语料」而不是「报告里写的」。
 * 两者在全新克隆里不一样：报告是随仓库发布的快照，本地是 0。
 *
 * @param {string} root
 * @returns {number}
 */
function countRunDirs(root) {
  const outDir = join(root, 'out')
  if (!existsSync(outDir)) return 0
  let n = 0
  try {
    for (const entry of readdirSync(outDir, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(outDir, entry.name, '_run.json'))) n++
    }
  } catch {
    // 读不到 `out/` 就是 0 个样本。**不要**在这里假装成功。
    return 0
  }
  return n
}

// ─────────────────────────────────────────────────────────────────────────────
// 操作 1：想法 → 设计 JSON
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{idea: string, out?: string, dry?: boolean, allowPartial?: boolean}} args
 * @param {{signal?: AbortSignal, root?: string}} [opt]
 */
export async function ideaToDesign(args, opt = {}) {
  const root = opt.root || ROOT
  if (!args || typeof args.idea !== 'string' || !args.idea.trim()) {
    return { ok: false, exitCode: 2, at: now(), reason: '必须给一个非空的 idea（中文想法）' }
  }
  const argv = [join(root, 'scripts', 'idea2design.js'), args.idea]
  if (args.out) argv.push('-o', resolve(root, args.out))
  if (args.dry) argv.push('--dry')
  if (args.allowPartial) argv.push('--allow-partial')

  const r = await run(nodeBin(), argv, { cwd: root, signal: opt.signal, timeoutMs: 5 * 60 * 1000 })
  if (r.code !== 0) {
    return {
      ok: false,
      exitCode: typeof r.code === 'number' ? r.code : 2,
      at: now(),
      reason: tail((r.err || r.out || '未知失败').trim(), 1500),
    }
  }
  const g = (re) => { const m = re.exec(r.out); return m ? m[1] : undefined }
  return {
    ok: true,
    exitCode: 0,
    at: now(),
    complexity: g(/复杂度\s*:\s*(\S+)/),
    components: Number(g(/器件\s*:\s*(\d+)\s*个/) || 0),
    connections: Number(g(/连接\s*(\d+)\s*条/) || 0),
    nets: Number(g(/网络\s*(\d+)\s*条/) || 0),
    netsList: (r.out.match(/^\s{2}网络\s*:\s*(.+)$/m) || [])[1] || '',
    parts: (r.out.match(/^\s{2}器件\s*:\s*(.+)$/m) || [])[1]?.trim().slice(0, 500) || '',
    path: g(/已写入\s*:\s*(.+)$/m)?.trim(),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 操作 2：设计 JSON → 制造文件（长跑，2–20 分钟）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{design: string}} args
 * @param {{signal?: AbortSignal, root?: string, timeoutMs?: number}} [opt]
 */
export async function build(args, opt = {}) {
  const root = opt.root || ROOT
  if (!args || typeof args.design !== 'string' || !args.design.trim()) {
    return { ok: false, exitCode: 2, at: now(), runDir: '', detail: '必须给 design（设计 JSON 路径）' }
  }
  const design = resolve(root, args.design)
  if (!existsSync(design)) {
    return { ok: false, exitCode: 2, at: now(), runDir: '', detail: `设计文件不存在：${design}` }
  }

  const lock = readLock(root)
  const r = await run(pwshBin(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', join(root, 'run-all.ps1'), '-Design', design],
  { cwd: root, signal: opt.signal, timeoutMs: opt.timeoutMs || DEFAULT_TIMEOUT })

  const all = r.out + '\n' + r.err
  let runDir = (/(?:流水线启动|输出目录|runDir)[^\n]*?([A-Za-z]:[\\/][^\s"']+)/.exec(all) || [])[1] || ''
  if (!runDir) {
    const m = /([A-Za-z]:[\\/][^\s"']*out[\\/][^\s\\/]+-[0-9]{8}-[0-9]{6})/.exec(all)
    if (m) runDir = m[1]
  }
  if ((!runDir || !existsSync(runDir))) {
    const name = (r.out.match(/设计\s*:\s*(\S+)/) || [])[1]
    runDir = name ? newestRunDir(root, name) : ''
  }

  const j = runDir ? readJson(join(runDir, '_run.json')) : null
  const gates = (j && j.gates) || {}
  return {
    ok: Boolean(j && j.ok),
    exitCode: typeof r.code === 'number' ? r.code : 2,
    at: now(),
    runDir: runDir || '',
    designName: (j && j.designName) || '',
    strategy: (all.match(/策略[=:]\s*(\S+)/) || [])[1] || '',
    drcPassed: Boolean(gates.drcPassed),
    drcViolations: Number(gates.drcLeafCount || 0),
    exportsOk: Number(gates.exportsOk || 0),
    exportsTotal: Number(gates.exportsTotal || 0),
    artifacts: Number(gates.artifacts || 0),
    elapsedSec: j && j.elapsedMs ? Math.round(j.elapsedMs / 100) / 10 : null,
    lockSeen: lock ? lock.design : null,
    detail: tail(all.trim(), 2000),
    logPath: runDir ? join(runDir, '_run.json') : '',
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 操作 3：目录 → 能不能下单（唯一的可下单权威）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{dir: string}} args
 * @param {{signal?: AbortSignal, root?: string}} [opt]
 */
export async function fabcheck(args, opt = {}) {
  const root = opt.root || ROOT
  if (!args || typeof args.dir !== 'string' || !args.dir.trim()) {
    return { orderable: false, exitCode: 2, at: now(), dir: '', blockerCount: 0, warningCount: 0, blockers: '', raw: '必须给 dir（产物目录）' }
  }
  const dir = resolve(root, args.dir)
  if (!existsSync(dir)) {
    return { orderable: false, exitCode: 2, at: now(), dir, blockerCount: 0, warningCount: 0, blockers: '', raw: `目录不存在：${dir}` }
  }
  const r = await run(nodeBin(), [join(root, 'scripts', 'fabcheck.js'), dir],
    { cwd: root, signal: opt.signal, timeoutMs: 2 * 60 * 1000 })

  let j = null
  try { j = JSON.parse(r.out) } catch { /* 退出码 2 时不保证是 JSON */ }
  const blockers = j && Array.isArray(j.blockers) ? j.blockers : []
  const warnings = j && Array.isArray(j.warnings) ? j.warnings : []
  return {
    orderable: r.code === 0,
    exitCode: typeof r.code === 'number' ? r.code : 2,
    at: now(),
    dir,
    blockerCount: blockers.length,
    warningCount: warnings.length,
    blockerIds: [...new Set(blockers.map((b) => (b && b.id) || '?'))],
    blockers: blockers.map((b) => `${(b && b.id) || '?'}: ${((b && b.msg) || '').slice(0, 200)}`).join('\n'),
    raw: j ? '' : tail((r.out + r.err).trim(), 1200),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 操作 4：全语料普查
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{settle?: number}} args
 * @param {{signal?: AbortSignal, root?: string}} [opt]
 */
export async function census(args = {}, opt = {}) {
  const root = opt.root || ROOT
  const script = join(root, 'out', '_probe', 'fab-census.py')
  const reportPath = join(root, 'out', '_probe', 'fab-census.json')

  // 失败也用同一个形状返回：`source: 'none'`。
  // 不这么做的后果是调用方得先判断「这个对象里到底有没有 source 字段」才能分支，
  // 而漏判就会把 undefined 当成一个正常取值（这个坑在 CI 上真踩到过）。
  const fail = (reason, raw) => ({
    ok: false, exitCode: 2, at: now(), source: 'none', reason,
    dirs: 0, fabOk: 0, blocked: 0, parseErrors: 0, inFlight: 0,
    raw: raw ?? '', reportPath: '',
  })

  if (!existsSync(script)) {
    return fail('找不到量具', `找不到量具：${script}\n（out/_probe/ 是随仓库发布的，若缺失说明克隆不完整）`)
  }

  // 记下跑之前的 mtime。跑完如果它没变，说明脚本**没有写出新结果**，
  // 那么读到的就是上一次（甚至是从仓库里带出来的）报告。
  // 不做这个判断，就会把一份旧数据盖上「现在」的时间戳 —— 那是最难发现的一类错。
  const mtimeBefore = fileMtime(reportPath)

  const argv = [script, '--quiet']
  if (args.settle) argv.push('--settle', String(args.settle))
  const py = pythonBin()
  const r = await run(py, argv, { cwd: root, signal: opt.signal, timeoutMs: 15 * 60 * 1000 })

  const failed = {
    ok: false,
    exitCode: typeof r.code === 'number' && r.code !== 0 ? r.code : 2,
    at: now(),
    source: 'none',
    reason: r.code === null ? `量具没能启动（${py}）` : `量具退出码 ${r.code}`,
    dirs: 0, fabOk: 0, blocked: 0, parseErrors: 0, inFlight: 0,
    raw: tail((r.out + r.err).trim(), 1500)
      || (r.code === null
        // spawn 失败时 stdout/stderr 都是空的。不补一句，用户看到的是一份「全部为 0
        // 且没有任何解释」的结果 —— 那比报错更难查。
        ? `无法执行 "${py}"。census 需要 Python 3。\n`
          + `装一个，或用环境变量指定：PCB_AUTO_PYTHON=<python 可执行文件路径>`
        : ''),
    reportPath: '',
  }

  // 退出码非 0 ⇒ **不要**去读报告文件。磁盘上可能躺着一份旧的，
  // 读它就是「量具读不到输入时保持沉默，还把上次的答案拿出来」。
  if (r.code !== 0) return failed

  const mtimeAfter = fileMtime(reportPath)
  const refreshed = mtimeAfter !== null && mtimeAfter !== mtimeBefore

  const j = readJson(reportPath)
  if (!j || !j.all) return failed

  const st = j.self_ok_true || {}
  const ids = j.blocker_ids || {}

  // 报告可能是**随仓库发布的快照**（作者机器上的 56 个目录），而本机 `out/`
  // 是空的。这时如实回答 0 —— `census` 问的是「我的语料怎么样」，
  // 不是「作者当年测到多少」。把快照的数字留在 `snapshotDirs` 里，别混进
  // `dirs`：`dirs: 56` 在一个空克隆里会被读成「你有 56 个目录」。
  const localDirs = countRunDirs(root)
  const reportDirs = j.all.n || 0
  const usingSnapshot = !refreshed && reportDirs > 0 && localDirs === 0
  if (usingSnapshot) {
    return {
      ok: true,
      exitCode: 0,
      at: now(),
      source: 'snapshot',
      sourceNote: '量具没有写出新报告，这份数据来自已有的 out/_probe/fab-census.json（可能是随仓库发布的快照）。要一次真实测量，请在有产物目录的仓库里跑。',
      corpusNote: `你的克隆里 out/ 没有产物目录，所以这次没有可测的样本。`
        + `报告里那份快照（${reportDirs} 个目录，测于 ${j.measured_at || '未知时刻'}）`
        + '描述的是作者机器，不是你的 —— 先跑出产物再来。',
      emptyNote: '没有可测量的产物目录（out/ 下没有带 _run.json 的目录）。这不是「全部可下单」，是没有样本。',
      localDirs: 0,
      snapshotDirs: reportDirs,
      snapshotAt: j.measured_at || null,
      dirs: 0, fabOk: 0, blocked: 0, parseErrors: 0, inFlight: 0,
      selfOkTrue: 0, selfOkTrueOk: 0,
      blockerIds: '', blockerMap: {},
      reportPath,
    }
  }

  return {
    ok: true,
    exitCode: 0,
    // at 是**这份数据什么时候测的**，不是「我什么时候读的」。两者不是一回事。
    at: mtimeAfter ? new Date(mtimeAfter).toISOString() : now(),
    // live = 刚刚真扫了一遍；snapshot = 脚本没写新文件，读到的是随仓库发布的旧报告。
    // 消费者必须能分辨 —— 否则「53/56 可下单」会被当成此刻的事实。
    source: refreshed ? 'live' : 'snapshot',
    ...(refreshed ? {} : {
      sourceNote: '量具没有写出新报告，这份数据来自已有的 out/_probe/fab-census.json（可能是随仓库发布的快照）。要一次真实测量，请在有产物目录的仓库里跑。',
    }),
    // 0 个目录不是「全部通过」。不加这一句，`dirs:0 / blocked:0 / ok:true`
    // 会被读成一份完美的成绩单 —— 而它其实一分数据都没有。
    ...((j.all.n || 0) === 0 ? {
      emptyNote: '没有可测量的产物目录（out/ 下没有带 _run.json 的目录）。这不是「全部可下单」，是没有样本。',
    } : {}),
    dirs: j.all.n || 0,
    // 本机语料有多大。通常和 dirs 相等；不相等就说明报告是别的机器上的快照。
    localDirs,
    fabOk: j.all.fab_ok || 0,
    blocked: j.all.fab_blocked || 0,
    parseErrors: j.all.fab_error || 0,
    inFlight: Array.isArray(j.in_flight) ? j.in_flight.length : 0,
    settle: typeof j.settle_s === 'number' ? j.settle_s : null,
    selfOkTrue: st.n || 0,
    selfOkTrueOk: st.fab_ok || 0,
    blockerIds: Object.entries(ids).map(([k, v]) => `${k}×${v}`).join(', ').slice(0, 400),
    blockerMap: ids,
    reportPath,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 操作 5：交付一致性复核
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{skipCensus?: boolean}} args
 * @param {{signal?: AbortSignal, root?: string}} [opt]
 */
export async function verify(args = {}, opt = {}) {
  const root = opt.root || ROOT
  const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', join(root, 'verify-delivery.ps1')]
  if (args.skipCensus) argv.push('-SkipCensus')
  const r = await run(pwshBin(), argv, { cwd: root, signal: opt.signal, timeoutMs: 20 * 60 * 1000 })
  const all = r.out + '\n' + r.err
  const line = /PASS\s+(\d+)\s+INFO\s+(\d+)\s+WARN\s+(\d+)\s+FAIL\s+(\d+)\s+ERROR\s+(\d+)/.exec(all)
  return {
    ok: r.code === 0,
    exitCode: typeof r.code === 'number' ? r.code : 2,
    at: now(),
    verdict: (/VERDICT=(\w+)/.exec(all) || [])[1] || 'UNKNOWN',
    pass: line ? Number(line[1]) : 0,
    info: line ? Number(line[2]) : 0,
    warn: line ? Number(line[3]) : 0,
    fail: line ? Number(line[4]) : 0,
    error: line ? Number(line[5]) : 0,
    failures: (all.match(/\[(?:FAIL|ERROR)\][^\n]*/g) || []).slice(0, 12).join('\n'),
    raw: line ? '' : tail(all.trim(), 1500),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 操作目录：CLI 与 MCP 共用同一张表，避免两套参数定义漂移
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 每个操作的自描述。CLI 用它生成 `--help`，MCP 用它生成 `tools/list`，
 * 所以**不存在**「文档说有、接口里没有」这种漂移。
 */
export const OPS = {
  'idea-to-design': {
    fn: ideaToDesign,
    summary: '把一句中文想法编译成设计 JSON（确定性：同一句想法 → 字节相同）',
    summaryEn: 'Compile a Chinese board idea into a design JSON (deterministic).',
    args: {
      idea: { type: 'string', required: true, description: '中文想法，例如「做一个 SHT30 温湿度采集板，I2C 经排针引出」' },
      out: { type: 'string', description: '输出路径，默认 designs/gen-<slug>.json' },
      dry: { type: 'boolean', description: '只打印，不写盘' },
      allowPartial: { type: 'boolean', description: '接受「想法点名了但配方装不上」的器件（默认拒绝，因为静默丢器件会做出一块少料的板却照样报通过）' },
    },
  },
  build: {
    fn: build,
    summary: '跑完整条流水线：设计 JSON → 布局 → 布线 → DRC → Gerber/BOM/PnP（2–20 分钟）',
    summaryEn: 'Run the full pipeline: design JSON → layout → routing → DRC → Gerber/BOM/PnP (2–20 min).',
    args: {
      design: { type: 'string', required: true, description: '设计 JSON 路径（相对仓库根或绝对路径）' },
    },
  },
  fabcheck: {
    fn: fabcheck,
    summary: '离线 DFM 闸门：这个目录能不能直接下单（退出码 0 可 / 1 阻断 / 2 调用错误）',
    summaryEn: 'Offline DFM gate: can this directory be ordered as-is (exit 0 / 1 / 2).',
    args: {
      dir: { type: 'string', required: true, description: '产物目录（相对仓库根或绝对路径）' },
    },
  },
  census: {
    fn: census,
    summary: '对全部已沉淀产物目录跑 DFM 闸门，给出可打样率',
    summaryEn: 'Run the DFM gate over every settled product directory and report the pass rate.',
    args: {
      settle: { type: 'integer', description: '目录要静默多少秒才算沉淀（默认 180）' },
    },
  },
  verify: {
    fn: verify,
    summary: '重跑全部交付一致性判据（跨文件对账、闸门覆盖、产物格式、孤儿目录）',
    summaryEn: 'Re-run every delivery consistency assertion.',
    args: {
      skipCensus: { type: 'boolean', description: '跳过 DFM 普查（约 17 s → 6 s）' },
    },
  },
}

/**
 * 按操作名分发，并把参数规范化。
 * @param {string} opName
 * @param {Record<string, unknown>} rawArgs
 * @param {{signal?: AbortSignal, root?: string, timeoutMs?: number}} [opt]
 */
export async function dispatch(opName, rawArgs, opt = {}) {
  const op = OPS[opName]
  if (!op) throw new Error(`未知操作：${opName}（可用：${Object.keys(OPS).join(', ')}）`)
  return op.fn(rawArgs || {}, opt)
}
