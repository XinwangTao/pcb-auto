/**
 * pcb-auto · 仓库根定位
 *
 * 单独一个文件的原因：它**只依赖 node: 内置模块**，所以可以在 DSH 之外被测试。
 * 如果把它和 `index.js` 放一起，测试就得先能 import `@deepseek-ai/dsh-tools`，
 * 那就只能在没有测试的集成环境里跑 —— 等于没测。
 *
 * 顺带一个真实需求：**任何配置文件里都不该出现别人的绝对路径。**
 * `link:` 安装时本包就在仓库内，所以自动探测一定成立。
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 判断一个目录像不像 pcb-auto 仓库根。 */
const looksLikeRoot = (p) => Boolean(p) && existsSync(join(p, 'core', 'ops.mjs'))

/**
 * 定位仓库根，按可靠性排序：
 *   1. `config.root`（显式给了就用）
 *   2. 环境变量 `PCB_AUTO_ROOT`
 *   3. 本包所在目录的上一级
 *
 * 第 3 条是常规路径：以 `link:` 方式安装时 `import.meta.url` 解析到仓库内，
 * 所以 `dir/..` 就是仓库根，**不需要把绝对路径写进 cordis.patch.yml**。
 *
 * @param {{root?: string}} [config]
 * @param {string} [selfUrl] 覆盖本模块的 URL（测试用）
 * @returns {{root: string, how: string}}
 * @throws 三条都失败时，错误信息里列出全部尝试过的路径
 */
export function locateRoot(config = {}, selfUrl = import.meta.url) {
  const tried = []

  if (config.root) {
    const p = resolve(String(config.root).replace(/[\\/]+$/, ''))
    tried.push(`config.root = ${p}`)
    if (looksLikeRoot(p)) return { root: p, how: 'config.root' }
  }

  const env = process.env.PCB_AUTO_ROOT
  if (env) {
    const p = resolve(env.replace(/[\\/]+$/, ''))
    tried.push(`PCB_AUTO_ROOT = ${p}`)
    if (looksLikeRoot(p)) return { root: p, how: 'PCB_AUTO_ROOT' }
  }

  const self = resolve(dirname(fileURLToPath(selfUrl)), '..')
  tried.push(`包所在位置推出的仓库根 = ${self}`)
  if (looksLikeRoot(self)) return { root: self, how: '包位置自动探测' }

  throw new Error(
    'pcb-auto: 找不到仓库根（缺 core/ops.mjs）。已尝试：\n  ' + tried.join('\n  ')
    + '\n\n解决方式（任选）：\n'
    + '  1) 以 link 方式安装 plugin/（pnpm link / plugin_manager 的 link:），这样能自动探测；\n'
    + "  2) 在 cordis.patch.yml 的 config 里写 root: '<仓库绝对路径>'；\n"
    + '  3) 设环境变量 PCB_AUTO_ROOT=<仓库绝对路径>。',
  )
}
