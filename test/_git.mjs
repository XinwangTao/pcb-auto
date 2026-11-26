/**
 * `git ls-files` 的唯一入口。
 *
 * ## 为什么值得单独一个文件
 *
 * 三个闸门（`syntax-gate` / `dev-path-scan` / `doc-refs`）都要枚举「哪些文件属于
 * 这个仓库」，而三处都直接 `execFileSync('git', ...)`，没有一个处理 `git` 不存在
 * 的情况。
 *
 * 实测（把 `git` 从 PATH 里去掉）：三个闸门**全部崩成退出码 1**，而且打印的是
 * 一段 `node:internal/child_process` 的栈。问题在于：在这几个闸门的约定里，
 * **退出码 1 的含义是「发现了失败」**。于是 CI 上看到一个红的闸门，没人能分清：
 *
 *   - 我的改动真的有语法错误 / 真的引入了本机路径 / 真的写坏了引用？
 *   - 还是这台 runner 上根本没有 git？
 *
 * 这两种情况的**处置完全相反**，却共用一个退出码。这比「检查器沉默」更糟 ——
 * 它不是不说，而是说了反话。
 *
 * 退出码 2 已经约定给「环境问题」。所以这里把所有「git 跑不起来」的情况
 * 统一归到 2，并且说清是哪一种。
 *
 * ## 注意
 *
 * 它直接 `process.exit(2)`。这是刻意的：这几个闸门都是命令行脚本，不是库；
 * 「连文件都枚举不出来」时不应该继续跑下去给出半个结论。`smoke.mjs` 会 import
 * `dev-path-scan.mjs` 的导出，那些导出在这个前提下同样不可信，所以整条链一起
 * 退 2 是对的。
 */

import { execFileSync } from 'node:child_process'

/** 环境问题（不是「发现了失败」）的退出码。 */
export const ENV_EXIT = 2

const GIT_HINT = [
  '',
  '这个闸门需要 git：它靠 `git ls-files` 决定「哪些文件属于这个仓库」。',
  '枚举不出文件，就不可能给出有意义的结论，所以退出 2，而不是 1。',
  '（退出码 1 的含义是「发现了失败」—— 那是一个**结果**，和这里不是一回事。）',
  '',
  '处置：装上 git 并让它出现在 PATH 上，或在一个含 .git 的工作树里运行。',
  'Windows 上常见原因：Git for Windows 装了但 PATH 里没有；',
  '或者刚改过 PATH 而当前 shell 会话还没刷新。',
  '',
].join('\n')

function bail(why, detail) {
  process.stderr.write(`\n[env] ${why}\n`)
  if (detail) process.stderr.write(`[env] ${detail}\n`)
  process.stderr.write(GIT_HINT)
  process.exit(ENV_EXIT)
}

/**
 * 跑一条 `git` 命令，按行（或按 NUL）返回。
 *
 * @param {string[]} args        git 的参数，例如 `['ls-files','-z']`
 * @param {object}   [opts]
 * @param {string}   [opts.root] 工作目录；不给就用当前目录
 * @param {boolean}  [opts.nul]  true = 输出以 NUL 分隔（文件名里有空格/换行也能安全切）
 * @param {number}   [opts.maxBuffer]
 * @returns {string[]}
 */
export function gitLines(args, opts = {}) {
  const { root, nul = false, maxBuffer = 64 << 20 } = opts
  let out
  try {
    out = execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      bail('找不到 git 可执行文件（spawnSync git ENOENT）。')
    }
    // git 存在但命令失败：最常见的是「不在 git 工作树里」。
    const err = e && e.stderr ? String(e.stderr).trim().split('\n')[0] : ''
    bail(
      `git ${args[0]} 执行失败（退出码 ${e && e.status}）。`,
      err || (e && e.message ? String(e.message).split('\n')[0] : ''),
    )
  }
  return out.split(nul ? '\0' : '\n').filter(Boolean)
}
