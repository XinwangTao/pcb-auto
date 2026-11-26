#!/usr/bin/env node
/**
 * pcb-auto · 通用安装器
 *
 * 目标：不假设用户用哪个 Agent。同一套 5 个操作，装进任何能连 MCP 或能执行 shell 的客户端。
 *
 * 三种接入方式，按「越通用越优先」排列：
 *   1. MCP（一次实现，覆盖所有 MCP 客户端）      ← 首选
 *   2. CLI（任何能执行命令的 Agent，连 MCP 都不需要） ← 最兜底
 *   3. 原生插件（DSH / Claude Code 有自己的插件机制）  ← 体验最好
 *
 * 安全设计：默认**只打印，不写盘**。`--write` 才会写，且写前备份、只写「项目内」的配置文件
 * （项目内配置随仓库走、可 review、可回滚）。全局配置一律只打印，让别人自己贴 ——
 * 因为我不知道你机器上还配了什么，覆盖你的全局配置是不礼貌的。
 *
 * 用法：
 *   node install/install.mjs                 # 打印全部接入方式
 *   node install/install.mjs --print cursor  # 只看一个
 *   node install/install.mjs --write         # 写项目内配置文件（可提交、可 review）
 *   node install/install.mjs --list          # 列出支持的客户端
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(join(HERE, '..'))
const NODE = process.execPath.replace(/\\/g, '/')
const SERVER = join(ROOT, 'mcp', 'server.mjs').replace(/\\/g, '/')

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }

/** 标准 MCP stdio 服务器条目（`mcpServers` 家族通用）。 */
const serverEntry = () => ({
  command: NODE,
  args: [SERVER],
  env: { PCB_AUTO_ROOT: ROOT.replace(/\\/g, '/') },
})

/** 每个客户端的接入方式。`verified` 是诚实字段：本机没验证过的就写 false。 */
const CLIENTS = {
  'dsh': {
    label: 'DeepSeek Harness (DSH)',
    mode: 'native-plugin',
    verified: true,
    how: [
      '1) 把 plugin/cordis.patch.yml 里的 root 改成 ' + ROOT,
      '2) 用 plugin_manager  install_bundle  target=' + join(ROOT, 'plugin'),
      '   （或在 Web GUI：插件 → 添加插件 → 选 plugin/ 目录）',
      '3) 重载后应看到 5 个工具：pcb_idea_to_design / pcb_build / pcb_fabcheck / pcb_census / pcb_verify',
      '',
      '本仓库的 DSH 插件是**薄壳**，运行时从 core/ops.mjs 加载实现 —— 所以仓库更新后插件自动跟着更新。',
    ].join('\n'),
  },
  'claude-code': {
    label: 'Claude Code',
    mode: 'native-plugin + mcp',
    verified: true,
    projectFile: '.mcp.json',
    globalFile: '~/.claude.json',
    key: 'mcpServers',
    how: [
      '项目内已带 .mcp.json（用 ${CLAUDE_PLUGIN_ROOT} 指向插件目录）。',
      '作为插件安装：/plugin marketplace add <this-repo> 然后在 /plugin 里启用 pcb-auto。',
      '只想要 MCP：把下面的 JSON 合并进 ~/.claude.json 的 mcpServers。',
    ].join('\n'),
  },
  'claude-desktop': {
    label: 'Claude Desktop',
    mode: 'mcp',
    verified: false,
    globalFile: 'Windows: %APPDATA%\\Claude\\claude_desktop_config.json',
    key: 'mcpServers',
    how: '把下面的 JSON 合并进 claude_desktop_config.json 的 mcpServers，重启客户端。',
  },
  'cursor': {
    label: 'Cursor',
    mode: 'mcp',
    verified: false,
    projectFile: '.cursor/mcp.json',
    globalFile: '~/.cursor/mcp.json',
    key: 'mcpServers',
    how: '项目内 .cursor/mcp.json，或全局 ~/.cursor/mcp.json。Settings → MCP 里可看到 server 与工具数。',
  },
  'windsurf': {
    label: 'Windsurf (Codeium)',
    mode: 'mcp',
    verified: false,
    globalFile: '~/.codeium/windsurf/mcp_config.json',
    key: 'mcpServers',
    how: '合并进 mcp_config.json 的 mcpServers。Cascade 面板里能看到工具。',
  },
  'vscode': {
    label: 'VS Code + GitHub Copilot',
    mode: 'mcp',
    verified: false,
    projectFile: '.vscode/mcp.json',
    key: 'servers',
    // 注意：VS Code 用的键名是 `servers`，且条目需要 `type: stdio`。
    // 这一条我没有在本机验证过，所以 verified:false —— 请不要当成事实引用。
    entryOverride: () => ({ type: 'stdio', ...serverEntry() }),
    how: 'VS Code 的键名是 `servers`（不是 `mcpServers`），条目需要 type: "stdio"。'
      + '本仓库未在本机验证该格式，若加载失败请用下面的通用 mcpServers 片段。',
  },
  'cline': {
    label: 'Cline (VS Code 扩展)',
    mode: 'mcp',
    verified: false,
    globalFile: '%APPDATA%\\Code\\User\\globalStorage\\saoudrizwan.claude-dev\\settings\\cline_mcp_settings.json',
    key: 'mcpServers',
    how: '在 Cline 的 MCP Servers 面板里点 Configure，把下面的条目贴进去。',
  },
  'roo-code': {
    label: 'Roo Code',
    mode: 'mcp',
    verified: false,
    globalFile: '%APPDATA%\\Code\\User\\globalStorage\\rooveterinaryinc.roo-cline\\settings\\mcp_settings.json',
    key: 'mcpServers',
    how: '在 Roo Code 的 MCP 面板里编辑 mcp_settings.json。',
  },
  'continue': {
    label: 'Continue',
    mode: 'mcp',
    verified: false,
    globalFile: '~/.continue/config.json',
    key: 'mcpServers',
    how: '合并进 ~/.continue/config.json（Continue 版本较旧时该键可能在 experimental 下）。',
  },
  'zed': {
    label: 'Zed',
    mode: 'mcp',
    verified: false,
    globalFile: '~/.config/zed/settings.json',
    key: 'context_servers',
    how: 'Zed 用 `context_servers` 这个键。未在本机验证，格式不同请查 Zed 文档。',
  },
  'codex-cli': {
    label: 'Codex CLI (OpenAI)',
    mode: 'mcp',
    verified: false,
    globalFile: '~/.codex/config.toml',
    key: 'toml',
    how: 'Codex 用 TOML。在 ~/.codex/config.toml 里加：\n\n'
      + '[mcp_servers.pcb-auto]\n'
      + `command = "${NODE}"\n`
      + `args = ["${SERVER}"]\n`
      + '[mcp_servers.pcb-auto.env]\n'
      + `PCB_AUTO_ROOT = "${ROOT.replace(/\\/g, '/')}"\n`,
  },
  'gemini-cli': {
    label: 'Gemini CLI (Google)',
    mode: 'mcp',
    verified: false,
    globalFile: '~/.gemini/settings.json',
    key: 'mcpServers',
    how: '合并进 ~/.gemini/settings.json 的 mcpServers。',
  },
  'qwen-code': {
    label: 'Qwen Code',
    mode: 'mcp',
    verified: false,
    globalFile: '~/.qwen/settings.json',
    key: 'mcpServers',
    how: 'Qwen Code 由 Gemini CLI 分叉而来，通常读 ~/.qwen/settings.json 的 mcpServers。未验证。',
  },
  'opencode': {
    label: 'opencode',
    mode: 'mcp',
    verified: false,
    globalFile: 'opencode.json',
    key: 'mcp',
    how: 'opencode 的 mcp 段结构不同（含 type/mcpServers 变体），请查其文档；也可以用下面的 CLI 方式。',
  },
  'openhands': {
    label: 'OpenHands',
    mode: 'mcp',
    verified: false,
    how: 'OpenHands 的 MCP 配置在设置 UI 的 MCP 页里加 stdio server。',
  },
  'goose': {
    label: 'Goose (Block)',
    mode: 'mcp',
    verified: false,
    how: 'Goose 用 `goose configure` → Extensions → Add MCP Server，填同样的 command/args。',
  },
  'amazon-q': {
    label: 'Amazon Q Developer CLI',
    mode: 'mcp',
    verified: false,
    how: 'Amazon Q CLI 的 MCP 配置在 ~/.aws/amazonq/mcp.json（结构类似 mcpServers，未验证）。',
  },
  'aider': {
    label: 'Aider',
    mode: 'cli',
    verified: true,
    how: 'Aider 没有 MCP。用 shell 方式：让 Aider 跑下面的命令即可，它会把 JSON 读走。',
  },
  'any-shell-agent': {
    label: '任何能执行命令的 Agent（通用兜底）',
    mode: 'cli',
    verified: true,
    how: '任何 Agent 只要能跑一条命令，就能用：\n\n'
      + `  node ${join(ROOT, 'cli', 'pcb.mjs')} list\n`
      + `  node ${join(ROOT, 'cli', 'pcb.mjs')} fabcheck out/d1\n`
      + `  node ${join(ROOT, 'cli', 'pcb.mjs')} census --settle 180\n\n`
      + '输出是单行 JSON（stdout），日志走 stderr。退出码 0 通过 / 1 判定为否 / 2 调用错误。',
  },
}

const snippet = (id) => {
  const c = CLIENTS[id]
  const entry = c.entryOverride ? c.entryOverride() : serverEntry()
  return JSON.stringify({ [c.key === 'toml' ? 'mcpServers' : c.key]: { 'pcb-auto': entry } }, null, 2)
}

if (has('--list')) {
  console.log('支持的客户端：\n')
  for (const [id, c] of Object.entries(CLIENTS)) {
    const v = c.verified ? '已在本机验证' : '未验证（照文档写的，请自行确认格式）'
    console.log(`  ${id.padEnd(18)} ${c.label.padEnd(32)} ${c.mode.padEnd(22)} ${v}`)
  }
  console.log(`\n共 ${Object.keys(CLIENTS).length} 个。任何 MCP 客户端都不需要我改代码即可接入。`)
  process.exit(0)
}

const only = val('--print')

if (has('--write')) {
  const targets = [
    ['claude-code', '.mcp.json'],
    ['cursor', '.cursor/mcp.json'],
    ['vscode', '.vscode/mcp.json'],
  ]
  for (const [id, rel] of targets) {
    const p = join(ROOT, rel)
    if (existsSync(p)) {
      copyFileSync(p, p + '.bak')
      console.log(`[skip] ${rel} 已存在，已备份为 ${rel}.bak（不覆盖，避免踩掉你已有的配置）`)
      continue
    }
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, snippet(id) + '\n', 'utf8')
    console.log(`[ok]   写了 ${rel}`)
  }
  console.log('\n提醒：这些文件里是**本机绝对路径**。提交到 git 前确认你的路径不含隐私信息。')
  process.exit(0)
}

// 默认：全部打印
for (const id of Object.keys(CLIENTS)) {
  if (only && only !== id) continue
  const c = CLIENTS[id]
  console.log('─'.repeat(78))
  console.log(`${id}  ·  ${c.label}   [${c.mode}]  ${c.verified ? '✓ 已在本机验证' : '⚠ 未验证'}`)
  console.log('─'.repeat(78))
  console.log(c.how)
  if (c.key === 'toml') {
    // TOML 已经写在 how 里了
  } else if (c.mode !== 'cli' && c.mode !== 'native-plugin') {
    if (c.globalFile) console.log(`\n全局配置位置：${c.globalFile}`)
    if (c.projectFile) console.log(`项目内配置位置：${c.projectFile}`)
    console.log('\n' + snippet(id))
  }
  console.log('')
}

console.log('─'.repeat(78))
console.log('不想配任何东西？一条命令就够：')
console.log(`  node ${join(ROOT, 'cli', 'pcb.mjs')} list`)
