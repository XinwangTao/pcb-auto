# 支持清单 · Supported Agent Platforms

> 这份清单的核心主张不是「我适配了 40 个平台」，而是：
> **我实现了两个通用标准，所以 N 个平台不需要我改一行代码就能用。**
>
> 这两个标准是：**MCP（Model Context Protocol）** 和 **纯 CLI**。
> 前者覆盖所有说过 MCP 的客户端，后者覆盖所有能执行命令的 Agent —— 包括没有 MCP 的。

最后更新：2026-11-26

---

## 三层接入，从最通用排到体验最好

| 层 | 机制 | 覆盖范围 | 需要我改代码吗 |
|---|---|---|---|
| **① CLI** | 一条命令 + JSON 输出 | **任何**能执行 shell 的 Agent | 不需要，永远不会 |
| **② MCP** | 标准 stdio JSON-RPC | 所有 MCP 客户端 | 不需要 |
| **③ 原生插件** | Cordis bundle / Claude Code plugin | DSH、Claude Code | 已做好 |

**为什么这么排**：③ 体验最好但最脆弱（每个平台的插件格式都不一样，而且会变）；① 最土但永远不会坏。
② 是中间那个甜点 —— 协议是稳定的，客户端是多的。

---

## 验证等级（请按这个读下面的表）

| 标记 | 含义 |
|---|---|
| ✅ **实测** | 我在本机真的跑通了：握手、`tools/list`、`tools/call`、错误码、stderr 分离 |
| 🟡 **协议级** | 我不测这个客户端，但我实现了它必须遵循的协议规范。**协议合规 ⇒ 能用** |
| ⚪ **据公开资料** | 该平台声称支持 MCP 或被广泛报告支持。**我没有逐个验证**，请自行确认 |

**这张表里只有 ✅ 和 🟡 是可以拿去做决定的。⚪ 只是给你找路用。**

---

## 一、已实测（✅）

| 平台 | 接入方式 | 实测内容 |
|---|---|---|
| **DeepSeek Harness (DSH)** | 原生插件（Cordis bundle） | 插件装载 → 注册 5 个工具 → 真调 `pcb_fabcheck` 得到 `exitCode=1` → 根路径写错时抛明确错误 |
| **Claude Code** | 原生插件 + MCP | `.claude-plugin/plugin.json` + `.mcp.json` 已就位；MCP 层与下面同一个服务器 |
| **任意 MCP 客户端** | MCP stdio | 完整握手：`initialize`（协议协商 2025-06-18）→ `notifications/initialized` → `tools/list`（5 工具）→ `ping` → `tools/call` → 未知工具 `-32602` → 未知方法 `-32601`；stdout 只有 JSON，日志全在 stderr |
| **任意 shell Agent** | CLI | `pcb list` / `pcb fabcheck out/d1`（位置参数与具名参数都通）/ 退出码 0 / 1 / 2 三态 |

---

## 二、协议级覆盖（🟡 不需要适配，只需协议合规）

### 国际

| 平台 | 厂商 | 接入 |
|---|---|---|
| Claude Code | Anthropic | MCP + 原生插件 |
| Claude Desktop | Anthropic | MCP |
| Cursor | Anysphere | MCP |
| Windsurf | Codeium / Cognition | MCP |
| GitHub Copilot (VS Code) | Microsoft / GitHub | MCP（键名 `servers`） |
| GitHub Copilot CLI | GitHub | MCP / CLI |
| Zed | Zed Industries | MCP |
| Cline | Cline Bot | MCP |
| Roo Code | Roo | MCP |
| Continue | Continue | MCP |
| Codex CLI | OpenAI | MCP（TOML 配置） |
| ChatGPT Desktop / Apps | OpenAI | MCP |
| Gemini CLI | Google | MCP |
| JetBrains AI Assistant / Junie | JetBrains | MCP / CLI |
| Amazon Q Developer CLI | AWS | MCP |
| Kiro | AWS | MCP |
| Goose | Block | MCP |
| Amp | Sourcegraph | MCP |
| Cody | Sourcegraph | MCP |
| Warp | Warp | MCP / CLI |
| Tabnine | Tabnine | 部分支持 MCP / CLI |
| Augment Code | Augment | MCP |
| Factory Droid | Factory | MCP |
| OpenHands | All Hands AI | MCP |
| Aider | Aider | **CLI**（无 MCP，用 shell 路径） |
| OpenCode | SST | MCP / CLI |
| Crush | Charm | MCP / CLI |
| Plandex | Plandex | CLI |
| SWE-agent | Princeton | CLI |
| Devin | Cognition | CLI / API |
| Replit Agent | Replit | CLI |
| v0 | Vercel | CLI |
| Bolt.new | StackBlitz | CLI |
| Lovable | Lovable | CLI |

### 国内

| 平台 | 厂商 | 接入 |
|---|---|---|
| **DeepSeek Harness (DSH)** | 深度求索 | 原生插件 ✅ + MCP + CLI |
| 通义灵码 / Lingma | 阿里云 | MCP / CLI |
| Qwen Code | 阿里云 | MCP（`~/.qwen/settings.json`） |
| 文心快码 Comate | 百度 | MCP / CLI |
| 腾讯 CodeBuddy | 腾讯 | MCP / CLI |
| Trae | 字节跳动 | MCP |
| 豆包 MarsCode | 字节跳动 | MCP / CLI |
| 扣子 Coze | 字节跳动 | MCP |
| 智谱 GLM Coding / AutoGLM | 智谱 AI | MCP / CLI |
| Kimi | 月之暗面 | MCP / CLI |
| 讯飞星火 iFlyCode | 科大讯飞 | MCP / CLI |
| CodeArts Snap | 华为云 | MCP / CLI |
| 商汤 日日新 | 商汤 | CLI |
| 阶跃星辰 StepFun | 阶跃星辰 | CLI |
| MiniMax | MiniMax | CLI |
| 面壁智能 | 面壁 | CLI |
| 阿里云百炼 | 阿里云 | MCP |

**这些行我不逐个保证。** 它们共享一个事实：只要该客户端「支持 MCP」或「能执行命令」，
就**不需要我发布新版本** —— 这是协议带来的杠杆，不是我做了 40 个适配。

---

## 三、如果你用的平台不在上面

按顺序试这三条，基本不会失败：

```bash
# 1) 最通用：任何 Agent 能跑命令就能用
node cli/pcb.mjs list
node cli/pcb.mjs fabcheck out/d1

# 2) 它有 MCP，但配置格式怪：只给它这一条，让它自己去读
node install/install.mjs --print cursor

# 3) 它连 shell 都没有：把它当 API 用
node cli/pcb.mjs census --settle 180   # 单行 JSON，喂给任何模型
```

打印全部平台的接入方式：

```bash
node install/install.mjs            # 打印 19 个客户端的配置片段
node install/install.mjs --list     # 列表 + 验证等级
node install/install.mjs --write    # 写项目内配置文件（写前备份，不覆盖已有）
```

---

## 四、加新平台要做什么

**大概率什么都不用做。** 只有两种情况需要写代码：

| 情况 | 要做的事 | 工作量 |
|---|---|---|
| 客户端符合 MCP 2025-06-18 / 2025-03-26 / 2024-11-05 | 无 | 0 |
| 客户端能执行 shell | 无 | 0 |
| 客户端有**自己的**插件格式（如 DSH 的 Cordis bundle） | 写一个薄适配层，从 `core/ops.mjs` 转发 | 约 100 行 |

适配层的规矩（看 `plugin/index.js` 就是范例）：

1. **不许复制逻辑。** 从 `core/ops.mjs` 动态 import，让适配层永远跟着仓库代码走。
2. **非零退出码是数据，不是异常。** 「不可下单」必须能被模型读成正常结果。
3. **输出必须有界。** 完整日志给路径，不给全文。
4. **长跑服从取消信号。**

---

## 五、诚实边界

- **只有 Windows 能真跑。** 原因是流水线依赖 PowerShell + 一个 Windows-only 的 EDA 服务端
  （`lceda-pro.exe --owner`）。Linux/macOS 上三层外壳都能装载，但 `build` 会失败。
- **`cli/` 和 `mcp/` 是零依赖的**（只用 Node 内置模块），因为依赖越少，能用的地方越多。
- **⚪ 那一整批我没有逐个验证。** 我验证的是协议，不是那些客户端。
  如果你在某个平台上踩到格式差异，那是配置问题，不是能力问题 —— 但我不假装我知道每个客户端的配置键名。
- 我没有测试过任何移动端或纯 Web 端的 Agent 接入。它们能不能跑取决于它们暴露什么沙箱。
