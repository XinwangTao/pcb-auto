# 架构

本文只写能从代码与产物里直接核实的事实。带 `文件:行号` 的地方都指向当前文件内容；数字都给了分母与测时。

## 0. 一句话

一个实现，三个薄壳。`core/ops.mjs` 是唯一的业务实现，`cli/`、`mcp/`、`plugin/` 只做协议转换，`scripts/` 是它调用的流水线本体（子进程）。

## 1. 三层结构

| 层 | 路径 | 形态 | 职责 |
|---|---|---|---|
| 实现层 | `core/ops.mjs` | ESM（`.mjs`），零第三方依赖 | 5 个操作的全部逻辑；参数校验、子进程、结果整形、退出码 |
| 适配层 | `cli/pcb.mjs` | ESM，零依赖 | 通用命令行：解析 `--flag`，打一行 JSON 到 stdout，日志到 stderr |
| 适配层 | `mcp/server.mjs` | ESM，零依赖 | MCP stdio JSON-RPC 2.0，工具名 `pcb_<op>` |
| 适配层 | `plugin/index.js` | DSH Cordis bundle | 把 5 个操作注册成 DSH 工具 |
| 流水线本体 | `scripts/` | CommonJS | 真正跟 EDA 打交道的步骤；只被 `build` / `fabcheck` / `census` 以子进程调用 |
| 数据 | `designs/`、`out/` | JSON | 输入设计与产物目录；`out/_probe/` 是量具 |

`core/ops.mjs` 里导出的表 `OPS` 是 5 个操作的自描述源（`core/ops.mjs:602`）。CLI 的 `--help` 与 MCP 的 `tools/list` 都从这张表生成，所以不存在「文档说有、接口里没有」。

## 2. 为什么这么分

三条理由都写在仓库自己的契约文件里，不是本文的推断。

| 理由 | 原文位置 | 内容 |
|---|---|---|
| 复制实现必然漂移 | `AGENTS.md:71` | 「**不要在 `cli/` `mcp/` `plugin/` 里复制业务逻辑。** 它们是适配层，从 `core/ops.mjs` 转发。复制出来的两份实现一定会漂移，然后就会出现『文档说 A、插件做 B』」 |
| `.js` 不能混入 ESM | `AGENTS.md:9` | 仓库根 `package.json` 故意没有 `"type": "module"`，`scripts/` 下的 `.js` 全是 CommonJS；要 ESM 就用 `.mjs` |
| 适配层要跟着仓库走 | `plugin/index.js:99` | 插件**动态** `import(pathToFileURL(corePath).href)`，不打包 core —— 打包会冻住一份旧实现 |

`package.json:45` 只声明 `"engines": { "node": ">=18.17" }`，**不声明 `"os"`**。下限 18.17 不是随手写的：`core/ops.mjs` 的 `run()` 用了 `AbortSignal.any`（Node 18.17 / 20.3 才有），更低版本会在第一次跑子进程时抛 `TypeError`。

## 3. 五个操作与调用者

| 操作 | core 函数 | 实际执行的子进程 | 谁能调用 |
|---|---|---|---|
| `idea-to-design` | `core/ops.mjs:288` | `node scripts/idea2design.js <想法>` | CLI、MCP、插件 |
| `build` | `core/ops.mjs:330` | `pwsh -File run-all.ps1 -Design <abs>` | CLI、MCP、插件 |
| `fabcheck` | `core/ops.mjs:386` | `node scripts/fabcheck.js <dir>` | CLI、MCP、插件 |
| `census` | `core/ops.mjs:423` | `python out/_probe/fab-census.py --quiet [--settle N]` | CLI、MCP、插件 |
| `verify` | `core/ops.mjs:567` | `pwsh -File verify-delivery.ps1 [-SkipCensus]` | CLI、MCP、插件 |

三个入口的操作名一致，只有拼写形态不同：

- CLI 子命令：`node cli/pcb.mjs fabcheck examples/d1`
- MCP 工具名：`pcb_fabcheck`（`-` 换 `_`）
- 插件工具名：同样 `pcb_fabcheck`

`build` 是唯一的长跑（自述 2–20 分钟）。它的两处预算：

| 预算 | 值 | 位置 |
|---|---|---|
| 子进程调用上限 | `DEFAULT_TIMEOUT = 45 * 60 * 1000` | `core/ops.mjs` / `plugin/index.js:36` |
| `run-all.ps1` 内部管道预算 | `$PipelineBudgetMs = $InvokeTimeoutMs - 60000`（默认 590000 − 60000 = 530000） | `run-all.ps1:71` |
| 流水线自用预算 | `BUDGET = Number((A && A.budgetMs) \|\| 530000)` | `scripts/pipeline3.js:26` |

## 4. 退出码契约

三个码，含义互斥，脚本可以直接依赖。

| 码 | 含义 | 方向 |
|---|---|---|
| `0` | 成功 / 可下单 / 通过 | 结论是「是」 |
| `1` | 判定为否 —— 跑完了，结论是「不行」 | **这是结果，不是错误** |
| `2` | 调用错误：参数不对、路径不存在、缺依赖、环境不对 | 一次都没开始跑 |

`fabcheck` 是这个契约最纯的形状：`orderable: r.code === 0`（`core/ops.mjs:403`），`scripts/fabcheck.js` 侧是 `exit: blockers.length ? 1 : 0`。参数缺失、目录不存在都直接返回 `exitCode: 2`，**不进** `scripts/fabcheck.js`。

CLI 侧的收尾是一行 `process.exit(code)`，`code` 优先取结果里的 `exitCode`，其次 `ok === false` 时给 1，异常一律 2。`--help` / `-h` 退 **0**（要帮助是成功的），完全不给子命令才退 2（`cli/pcb.mjs:126`）。未知子命令退 2（`cli/pcb.mjs:152`）。

未知 `--flag` 也退 2，并且**不许被降级成警告后继续跑**：一个要跑 2–20 分钟、要写盘、要占 EDA 进程的操作，用户以为传了个开关而实际什么都没发生，是最坏的宽容。历史上有一次 `--dry` 漏进了 `allowPartial`，就是这条规则的由来。

## 5. MCP 里 `isError` 只在退 2 时为真

```js
// mcp/server.mjs:135-137
// isError 只在**调用失败**时为 true；判定为「否」不是错误，
// 它是一个正常结果，模型必须能读出 isError=false + orderable=false。
const isError = result.exitCode === 2
```

理由是消费方不同：MCP 客户端会把 `isError: true` 当成「工具坏了」并可能重试或改道，而「这块板不能下单」需要模型**读懂并继续推理**，不是换条路再问一次。若把退 1 标成 `isError`，可下单性问题就被降级成传输层故障，模型的处置全错。

这条有断言钉着：`test/smoke.mjs` 的「`tools/call pcb_fabcheck` 返回退出码 1 且 `isError=false`」与「对不存在的目录返回退出码 2 且不崩」。

## 6. `fabcheck` 退出码 ≠ `_run.json.ok`

两个问题，两个答案：

| 字段 | 回答的问题 |
|---|---|
| `_run.json.ok` | 流水线**自己**跑完了没有 |
| `fabcheck` 退出码 | 这个目录**能不能下单** |

实测（`out\` 语料 56 个含 `_run.json` 的目录，快照 `out/_probe/fab-census.json`，settle 180 s，测于该文件 `measured_at` = 2026-11-26 10:08 +08:00）：

| | `fabcheck` 可下单 | `fabcheck` 有阻断 | 合计 |
|---|---|---|---|
| `ok = true` | 48 | **0** | 48 |
| `ok = false` | 5 | 3 | 8 |
| 合计 | 53 | 3 | 56 |

- 危险方向（自称 `ok` 但不可下单）**0 次**。
- 悲观方向（`ok = false` 但可下单）**5 次**。
- 两个 48 相等是**巧合**，两个集合不同。

这是一次测量，不是保证。所以规则是硬的：**可下单性只认 `fabcheck` 退出码**，`_run.json.ok` 只能用来判断「这一轮流水线是不是跑完了」。

## 7. 流水线阶段顺序

`scripts/pipeline3.js` 每进入一个阶段就写一条 `PHASE` 日志：`const phase = n => log('PHASE', { n, ms: Date.now() - T0 })`（`scripts/pipeline3.js:16`）。当前共有 18 处调用，顺序如下。

| # | 阶段 | 位置 | 做什么 |
|---|---|---|---|
| 1 | `resolveParts` | `scripts/pipeline3.js:203` | 按 LCSC 号解析器件 |
| 2 | `createProject` | `scripts/pipeline3.js:236` | 建工程 |
| 3 | `createBoard` | `scripts/pipeline3.js:255` | 建板 |
| 4 | `placeParts` | `scripts/pipeline3.js:318` | 放器件 / 应用 `_placement` |
| 5 | `connect` | `scripts/pipeline3.js:517` | 连线 + 网络符号 |
| 6 | `netlistCheck` | `scripts/pipeline3.js:609` | 网表一致性 |
| 7 | `pcbImport` | `scripts/pipeline3.js:647` | 原理图 → PCB |
| 8 | `autoLayout` | `scripts/pipeline3.js:678` | 自动布局 |
| 9 | `preVia` | `scripts/pipeline3.js:1210` | 布线前打过孔 |
| 10 | `copperPour` | `scripts/pipeline3.js:1285` | 铺铜（布线前一次） |
| 11 | `autoRouting` | `scripts/pipeline3.js:1398` | 自动布线 |
| 12 | `snapEnds` | `scripts/pipeline3.js:1810` | 端点吸附（1.5 mil 阈值，治浮点断连） |
| 13 | `stitchGaps` | `scripts/pipeline3.js:2014` | 补线缝合 |
| 14 | `fixClearance` | `scripts/pipeline3.js:2198` | 间距修复 |
| 15 | `restitchEp` | `scripts/pipeline3.js:3972` | **条件执行**：`epViaRecs.length && left() > 120000` |
| 16 | `patchDrc` | `scripts/pipeline3.js:4060` | 按 DRC 结果打补丁（会整轮撤回，见 `docs/FAILURES.md` 第 23 条） |
| 17 | `drc` | `scripts/pipeline3.js:4454` | 详细 DRC + 布尔 DRC |
| 18 | `export` | `scripts/pipeline3.js:4859` | Gerber / BOM / PnP / Netlist / TestPoints / PDF |

两点容易读错：

- **第 15 步不是必经**。它只在「有 EP 过孔记录且剩余预算 > 120 s」时跑。
- **铺铜跑两次**。布线前铺一次，布完清掉、DRC 前再铺一次；日志里 `copperPour` 只出现在第 10 步，第二次是函数复用，不是新阶段。

## 8. 运行时矩阵

依赖按操作分，不按包分（这也是 `package.json` 不写 `"os"` 的原因）。

| 操作 | Node 下限 | 还要什么 | 哪能跑 |
|---|---|---|---|
| `idea-to-design` | ≥ 18.17 | 无（只用 Node 内置模块） | 任何系统 |
| `fabcheck` | ≥ 18.17 | 无（只用 Node 内置模块） | 任何系统 |
| `census` | ≥ 18.17 | Python 3 | 任何系统 |
| `verify` | ≥ 18.17 | `pwsh` + Python 3（含普查时） | 任何装了 `pwsh` 的系统 |
| `build` | ≥ 18.17 | `pwsh` + 嘉立创 EDA Pro **4.1.111** | **仅 Windows** |

`build` 在 Linux/macOS 上退 **2**（没能运行），不退 1。退 1 会被读成「这块板有问题」，而真相是「这台机器没有画板的工具」，处置完全相反。

## 9. 解释器定位与环境变量

查找顺序（`scripts/tool-paths.ps1:13`）：环境变量 → 常见安装位置 → 通配路径 → PATH 上的命令。全都不中就直接停下，并打印试过的每一条。

| 环境变量 | 作用 | 定义处 |
|---|---|---|
| `PCB_AUTO_ROOT` | 覆盖仓库根。默认 `core/` 的上一级 | `core/ops.mjs:20`、`plugin/locate-root.mjs:42`、`install/install.mjs:40` |
| `PCB_AUTO_NODE` | 指定 Node 可执行文件。默认就是跑 `core/ops.mjs` 的那个 | `core/ops.mjs:181`、`scripts/tool-paths.ps1:108` |
| `PCB_AUTO_PWSH` | 指定 `pwsh`。`build` / `verify` 用 | `core/ops.mjs:184` |
| `PCB_AUTO_PYTHON` | 指定 Python。`census` 用 | `core/ops.mjs:191`、`scripts/tool-paths.ps1:132` |
| `PCB_AUTO_LCEDA` | 指向 `lceda-pro.exe`（与 `LCEDA_PRO_EXE` 同义，前者优先） | `scripts/tool-paths.ps1:91` |
| `PCB_AUTO_GIT` | 指定 `git`。`test/_git.mjs` 用它把「缺 git」造成退出码 2 | `test/_git.mjs:52` |
| `PCB_AUTO_VERBOSE` | 打开插件的详细日志 | `plugin/index.js:102` |
| `PCB_AUTO_FFMPEG` | 指定 ffmpeg。只有录制/合成视频时需要 | `scripts/record-final.ps1:28` |
| `PCB_AUTO_FFPROBE` | 指定 ffprobe。同上 | `scripts/record-final.ps1:34` |

Python 的解析顺序在 `tool-paths.ps1` 里被刻意排在 PATH 之前的两档是「环境变量 → DSH 自带运行时」。原因写在源码注释里：本机 PATH 上的 python 是 Anaconda，而量具历来跑在 DSH 自带那个上；顺序一变，量具输出会悄悄变，且没人会注意到（两者都能跑）。

## 10. 设计 JSON 结构

最小例子 `designs/d1-sht30.json`（3 器件 / 11 连接）：

```json
{
  "name": "SHT30_I2C_TempHumidity",
  "boardWidthMil": 800,
  "boardHeightMil": 600,
  "components": [{ "des": "U1", "lcsc": "C86346" }],
  "connections": [["U1", "5", "VDD"], ["U1", "8", "GND"]]
}
```

| 字段 | 类型 | 语义 | 依据 |
|---|---|---|---|
| `name` | string | 工程名。同名已存在时 `createProject` **静默返回 undefined**，所以流水线自动加时间戳后缀 | `README.md` |
| `friendly` | string | 展示名，可选 | `designs/d1-sht30.json` |
| `_idea` / `_why` | string | 想法原文与选型理由，可选。下划线前缀表示流水线不读 | `designs/d1-sht30.json` |
| `boardWidthMil` / `boardHeightMil` | number | 声明板框，单位 **mil** | `README.md` |
| `components[]` | `{des, lcsc, value?}` | 位号 + LCSC 号 + 可选值 | 同上 |
| `connections[]` | `[位号, **引脚号**, 网络名]` | 只写要连的引脚；引脚号是字符串 | `designs/d1-sht30.json` |
| `noConnect[]` | `"位号.**引脚名**"` | 声明「有意不接」 | `scripts/audit-design.js:155` |
| `_placement` | **对象（dict）**，不是数组 | `{位号: {x, y, rot?}}`，钉死坐标；`rot` 单位是度 | `designs/mic-esp32s3-v4.json` |
| `_antennaKeepout` | object | 天线净空带 `{x0,x1,y0,y1,allowDesignators,minGapMilToOthers,why}` | `scripts/pipeline3.js` 的 `antennaKeepout` 段 |

三个容易写错的点：

1. **`_placement` 是对象不是数组。** 键是位号，值是 `{x, y, rot?}`。写成数组会静默失效。
2. **`connections` 用引脚号，`noConnect` 用引脚名。** 两者不可互换：`["U1","5","VDD"]` 里 `5` 是引脚号；`"U1.IO1"` 里 `IO1` 是引脚名。`scripts/audit-design.js` 按 `${des}.${引脚名}` 查 `noConnect` 集合。
3. **单位是 mil，坐标系是笛卡尔、y 向上**，与 `getState_X/Y` 同源。**不要写 mm。** 1 mm = 39.37 mil。板框与器件坐标必须同一套单位，混用不会被任何闸门拦住，只会得到一块尺寸离谱的板。

`_placement` 会把 `outlineFit` 逼进 `explicitFixed` 分支：只放大板框、**器件一个都不动**。此时扩大板框在几何上不可能改变任何一条 DRC —— 实测面积 +56% 而 DRC 直方图逐位相同（`docs/FAILURES.md` 第 26 条）。

## 11. `_run.json` 字段

一次成功的构建（`out\SHT30_I2C_TempHumidity-20261126-050157\_run.json`，测于 `generatedAt` = 2026-11-25T21:08:54.684Z）：

| 字段 | 值 | 含义 |
|---|---|---|
| `kind` | `"pipeline"` | 文件种类 |
| `ok` | `true` | 流水线自述跑完 —— **不是可下单性** |
| `boardWidthMil` / `boardHeightMil` | `1000` / `750` | **布局前的声明值**，扩板后不回写 |
| `designName` | `"SHT30_I2C_TempHumidity"` | 设计名。**没有** design 文件路径字段 |
| `components` / `connections` | `3` / `11` | 数量 |
| `elapsedMs` | `194455` | 本次耗时 |
| `projectUuid` | 64 hex | 工程 id |
| `generatedAt` | ISO 8601（UTC） | 落盘时刻 |
| `gates.drcPassed` | `true` | 布尔 DRC |
| `gates.drcLeafCount` / `drcTotalCount` | `0` / `0` | 详细 DRC 叶子数 / 总数 |
| `gates.exportsOk` / `exportsTotal` / `artifacts` | `6` / `6` / `6` | 导出产物 |
| `gates.routeState` / `layoutState` | `"completed"` | 布线 / 布局作业自报状态 |
| `gates.pouredCount` | `2` | 重建的铜皮块数 |

`gates.routeState = "completed"` 只说明「作业怎么结束的」，不说明「板子通没通」。这两件事在 `docs/FAILURES.md` 第 16 条里被分开讨论过：布线器把「这份配置布不通」也报成 `completed`。

## 12. 测试闸门

入口 `npm test` 串行跑 8 个闸门（`package.json:49`）：

| # | 闸门 | 证明什么 | 退出码 |
|---|---|---|---|
| 1 | `test/syntax-gate.mjs` | 每个文件按**它真实的执行形式**能解析（`.js` 先 CommonJS、再包成 invoke 函数体、再 ESM） | 0 / 1 / 2 |
| 2 | `test/dev-path-scan.mjs` | 功能级文件里没有开发者本机痕迹，且豁免表没有失效条目 | 0 / 1 |
| 3 | `test/doc-refs.mjs` | 发布文档里每个 `文件:行号` 还能指到非空行 | 0 / 1 |
| 4 | `test/placement-rules.mjs` | `audit-placement.mjs` **会失败，也只会为自己失败**（每条判据配定向变异 + 阴性对照） | 0 / 1 / 2 |
| 5 | `test/capability-gate.mjs` | 未验证能力不许出现在无人值守依赖链上 | 0 / 1 / 2 |
| 6 | `test/smoke.mjs` | 三层外壳把参数送到同一个实现、退出码语义一致、`census` 的 `live`/`snapshot` 分辨 | 0 / 1 |
| 7 | `test/plugin-harness.mjs` | `plugin/index.js` 被 `apply()` 后真往工具表里放下 5 个工具 | 0 / 1 |
| 8 | `test/mutants.mjs` | `fabcheck` 的每条判据都能被一个具体故障点亮 | 0 / 1 / 2 |

退出码契约（`test/` 下通用）：

| 码 | 含义 | 处置 |
|---|---|---|
| `0` | 通过 | —— |
| `1` | **发现了失败**（这是一个结论） | 去修被测对象 |
| `2` | **没能测量**（缺 git / python / pwsh、输入为空、JSON 坏） | 去修输入或环境 |

2 与 1 的处置完全相反，所以不许合并。这条契约曾经被违反过：三个闸门直接 `execFileSync('git', ...)`，把 `git` 从 PATH 去掉后全部崩成 1，CI 上没人分得清「代码有语法错误」和「runner 没装 git」。统一入口现在是 `test/_git.mjs` 的 `gitLines()`。

三条与「闸门可信度」直接相关的规则，都写进了闸门自身：

- **别把「没检」写进「通过」的分母。** `syntax-gate` 分开报「解析了 M 个有可检语法的文件」与「另 K 个没有可检语法 —— 不算通过」。
- **量具读不到输入时不许沉默。** `census` 的 `source` 字段区分 `live`（刚真扫过）与 `snapshot`（脚本没写新报告，读到的是旧数据）。`dirs: 0` 是**没有样本**，不是全部通过。
- **闸门必须扫「未跟踪」文件。** 否则它对新文件是瞎的 —— `dev-path-scan` 曾经在 `scripts/tool-paths.ps1` 还没 commit 时对它报 PASS，而那个文件里正好写着两条作者机器路径。
