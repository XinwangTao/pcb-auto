# AGENTS.md · 给在这里干活的 AI 的契约

> 这份文件是给**在你之后进来的模型**读的。不是给人看的介绍，是硬约束。
> 如果你只读一段，读「三条不许」。

## 三条不许

1. **不许在 `scripts/*.js` 下面加 `import`/`export`。**
   仓库根的 `package.json` 故意**没有** `"type": "module"`。`scripts/` 下 247 个文件全是
   CommonJS。加一行 ESM 语法会让整条流水线同时失效，而且报错信息会指向一个跟根因无关的地方。
   需要 ESM 就用 `.mjs` 扩展名（`core/`、`cli/`、`mcp/`、`plugin/`、`install/` 都是这么做的）。

2. **不许把「能不能下单」判成 `_run.json.ok`。**
   唯一的权威是 `fabcheck` 的退出码（0 可下单 / 1 阻断 / 2 调用错误）。
   `_run.json.ok` 回答的是「流水线自己跑完了没有」，这是另一个问题。
   实测 56 个目录里两者在危险方向分歧 0 次、悲观方向分歧 5 次 —— 但那是一次测量，不是保证。

3. **不许写没有分母的数字。**
   任何一个百分比、任何一个「通过率」，必须同时给出：
   - 分母是什么（哪个集合）
   - 这个分母为什么可以变（settle 窗口 / 时刻 / 是否含在飞目录）
   - 测于何时（ISO 8601）

   同一个 `out\` 语料在 settle 0 / 180 / 实时扫描下会给出三个**都成立**的目录数。
   写「56 个目录」而不写时刻和窗口，这个数字就没有意义。

## 改文件的规矩

| 规则 | 原因 |
|---|---|
| 一个文件只有一个写者 | 两个 agent 并发写同一路径会互相覆盖，而且**不会报错** |
| 改前记 `sha256_12`，改后打印落地的那一行 | `.lastgood` / `.bak` **不是备份**，是陷阱 |
| 语法闸门：`.js` 用 `node --check`，`.py` 用 `py_compile` **且** `-W error::SyntaxWarning`，`.ps1` 用解析器 | `py_compile` 单独会放过 `'designs\<'` 这种无效转义 |
| 幂等断言：`count(anchor) == 1` 再替换 | 同一个锚点出现两次时，替换会改错地方而且静默成功 |
| PowerShell 里 `+` 必须在行尾才能续行 | 行首的 `+` 会报「表达式中缺少右括号」，跟真实错误毫无关系 |
| 量具要能**失败** | 只在好样本上跑一遍不算验证。故意把生成器改坏，看断言会不会红 |

## 环境事实（本机实测，不要重新猜）

```
Node          E:\APP\nodejs24\node.exe        (Node 24)
ffmpeg        C:\ffmpeg\bin\
Python        C:\Users\UserX\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe
Obsidian 库   D:\Users\陶鑫旺\Documents\Obsidian Vault
TEMP（写工具） D:\Users\陶鑫旺\AppData\Local\Temp
TEMP（shell）  F:\cache\temp          ← 两个不一样，别混
```

`web_search` 在本机**一定失败**（缺 `DEEPSEEK_API_KEY`）。不要先撞一次再降级。
直接走 `web_fetch https://cn.bing.com/search?q=<编码>&format=rss`。
域名必须是 `cn.bing.com`；`www.bing.com` 会跨域跳转失败。

## 目录职责

```
core/ops.mjs        ★ 唯一实现。5 个操作都在这。改行为只改这里
cli/pcb.mjs         薄壳：通用 CLI（零依赖）
mcp/server.mjs      薄壳：MCP stdio 服务器（零依赖）
plugin/             薄壳：DSH Cordis bundle（运行时 import core）
install/install.mjs 通用安装器：19 个客户端配置，默认只打印不写盘
scripts/            流水线本体（CommonJS，247 个文件）
designs/            设计 JSON（33 个）
out/                产物目录（56 个带 _run.json）+ out/_probe/ 量具
docs/               SUPPORT.md（平台矩阵）、WHY.md（对比）
llms.txt            机器可读入口
```

**不要在 `cli/` `mcp/` `plugin/` 里复制业务逻辑。** 它们是适配层，从 `core/ops.mjs` 转发。
复制出来的两份实现一定会漂移，然后就会出现「文档说 A、插件做 B」。

## 跑之前先看有没有人在跑

```powershell
Get-Content .pipeline.lock    # 存在 = 有人在跑
Get-CimInstance Win32_Process -Filter "Name='lceda-pro.exe'" |
  Where-Object { $_.CommandLine -match '--owner' } | Measure-Object   # 只数 --owner 的
```

`.pipeline.lock` 在**仓库根**，不是 `out\` 里。字段 `pid=` / `start=` / `design=`。

**绝对不要用 `os.kill(pid, 0)` 探测进程存活。** Windows CPython 里那是
`TerminateProcess(handle, 0)`，会把持有锁的进程**真的杀掉**（退出码 0，看起来像正常退出）。
只比时间戳。

## 验收 = 自己重跑，不是读别人的结论

- `complete` 不是通过。子 agent 的 `STATUS={"status":"ok"}` 也只是自述。
- 交付一致性用 `verify-delivery.ps1`（19 组判据）。
- 产物可打样性用 `node cli/pcb.mjs census --settle 180` 自己重算。
- 闸门只锚在**稳定子串**上，不要锚整句散文 —— 散文一改，闸门就自腐。
- 一个在读不到输入时**保持沉默**的检查，不是检查。

## 已知的坑（都踩过，别再踩）

- `fabcheck.js` 的输出里 `"id"` 这个键出现在 **4 个数组**（blockers/warnings/notes/passes）。
  用正则数 `"id"` 会把阻断数放大 ~19 倍。要 `ConvertFrom-Json` 后取 `@($j.blockers)`。
- `fabcheck.js --quiet` 只打一行摘要，**不是 JSON**，别拿去 parse。
- `--selftest` 需要一个位置参数（好样本目录），不给会崩。
- `out\` 会被自动清理（`run-overnight.ps1` 每 3 轮跑一次 `scripts\cleanup.ps1`，
  策略：保留最新 40 个 + 每个设计名最新 1 个）。所以**不要把唯一副本放进 `out\`**。
- 判定「在飞」的 settle 窗口如果比一次尝试还短，你测到的是**上一次**的残留。
  一次尝试可能 400 秒，而常见 settle 是 180 秒 —— 这是个真实的测量 bug。
- 重试阶梯 `smart-fit → expand-1.25x → retry → retry2` **会让结果变差**。
  有设计第 1 次 1 个 DRC 组，第 4 次变成 2 个组、SMD 违规从 1 涨到 46。
  不要以为「再试一次会更好」。
- **量具读不到输入时不许沉默**。`census` 的输出里有 `source` 字段：
  `live` = 刚刚真扫过；`snapshot` = 脚本没写新报告，读到的是磁盘上的旧数据。
  曾经因为 `fab-census.py` 写死开发者路径 + `ops.mjs` 不看退出码就读旧报告，
  在一个**没有任何产物**的全新克隆里报出「56 个目录 / 53 可下单」。
  这类错不报错、只给出一个看起来正常的数字，是最难发现的。`test/smoke.mjs` 第 8 组钉着它。
- `dirs: 0` 不是「全部通过」，是**没有样本**。`0/0` 读成 100% 是同一类错误的另一种形状。

## 如果你要加一个平台的支持

**大概率不用写代码。** 先看 `docs/SUPPORT.md`：

- 客户端符合 MCP → 零改动
- 客户端能执行 shell → 零改动
- 客户端有自己的插件格式 → 在 `plugin/` 旁边加一个 ~100 行的薄壳，从 `core/ops.mjs` 转发

薄壳的四条规矩：不复制逻辑 / 非零退出码是数据不是异常 / 输出有界 / 服从取消信号。
