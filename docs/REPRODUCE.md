# 复现

目标：拿到仓库的人能在自己机器上判断「这套东西到底跑不跑得起来」，而不是照抄一段别人机器上的成功日志。

所有命令都在仓库根 `pcb-auto\` 下执行。所有时间戳都是 ISO 8601，都是**实测**，不是估算。

## 0. 先看一眼有没有人在跑

```powershell
Get-Content .pipeline.lock
```

有内容 = 有人在跑，别插队（原因见第 5 节）。没有这个文件 = 空。

## 1. 只靠 Node 的最小可跑

三个操作不需要 EDA、不需要 PowerShell、不需要 Python。只要 Node ≥ 18.17。

```powershell
node cli/pcb.mjs list
node cli/pcb.mjs idea-to-design "做一个 SHT30 温湿度采集板，I2C 经排针引出" --dry
node cli/pcb.mjs fabcheck examples/d1
```

实测（测于 2026-11-26，Node v24.19.0）：

| 命令 | 退出码 | 输出要点 |
|---|---|---|
| `list` | **0** | 5 个操作的自描述表，含每个参数的类型与是否必填 |
| `idea-to-design ... --dry` | **0** | `{"ok":true,...,"complexity":"传感器模块","components":5,"connections":15,"nets":4}`，只打印不写盘 |
| `fabcheck examples/d1` | **1** | `{"orderable":false,"exitCode":1,"blockerCount":1,"blockerIds":["gerber.copper.thin"]}` |

第三条退 **1** 是正常的，**不是装错了**：`examples/d1` 是一块故意留了缺陷的样例板，阻断理由是 `gerber.copper.thin: 总铜图元 27 < 40，疑似零铜`（测于 2026-11-26T10:55:07.810Z）。

想看到退 0 的 `fabcheck`，得先有一份**别人真跑出来的**产物目录（第 3 节），或者从 `out/` 里挑一个可下单的：

```powershell
node cli/pcb.mjs fabcheck out/AI_RP2040_系统_15pqy38-20261126-082852
```

`examples/d1` 与 `out/` 里任何一个目录都不该被当成「通过样本」长期引用 —— 它们会随语料变化而改变结论。每次从当下语料里挑。

## 2. 完整跑的前提

| 依赖 | 为什么需要 | 缺了会怎样 |
|---|---|---|
| Node ≥ 18.17 | 所有入口 | 低于 18.17 第一次跑子进程就抛 `TypeError`（用了 `AbortSignal.any`） |
| `pwsh`（PowerShell 7） | `build` 与 `verify` 都经它转发 | 退 **2**，并打印「build / verify 需要 PowerShell 7」 |
| 嘉立创 EDA Pro **4.1.111** | `build` 唯一的画板工具，GUI 与 CLI 是同一个 exe | 退 **2**，并把你试过的每条路径打出来 |
| Windows | `run-all.ps1` 用 `Get-CimInstance` 数 `lceda-pro.exe --owner` 进程；EDA 只有 Windows 版 | `build` 在 Linux/macOS 上没有可替代依赖 |
| Python 3 | 只有 `census` / `verify`（含普查时）需要 | 退 **2**，`source: "none"` |

定位顺序（`scripts/tool-paths.ps1:13`）：环境变量 → 常见安装位置 → 通配路径 → PATH 上的命令。全都不中就停下并打印试过的每一条。这条设计的理由是：写一条具体的作者路径，等于给读者一条可以照抄的错误答案。

### `PCB_AUTO_LCEDA` 指向什么

指向 **`lceda-pro.exe` 这个可执行文件本身**，不是安装目录，也不是 `bin\`。

```powershell
$env:PCB_AUTO_LCEDA = "某个位置\lceda-pro.exe"
```

同义的备用名是 `LCEDA_PRO_EXE`（前者优先）。不设也能跑 —— 会按 `Program Files\LCEDA Pro\`、`Program Files (x86)\`、`%LOCALAPPDATA%\Programs\lceda-pro\` 等常见位置逐个找，最后试 PATH 上的 `lceda-pro`（`scripts/tool-paths.ps1:89`）。

其它三个解释器的环境变量：`PCB_AUTO_NODE`、`PCB_AUTO_PWSH`、`PCB_AUTO_PYTHON`。完整清单见 `docs/ARCHITECTURE.md` 第 9 节。

## 3. 一次真实构建

```powershell
pwsh -NoProfile -File .\run-all.ps1 -Design designs\d1-sht30.json
```

也可以从一句中文想法直接出板：

```powershell
pwsh -NoProfile -File .\run-all.ps1 -Idea "做一个 SHT30 温湿度传感器，带 LED 指示和排针引出"
```

`-Idea` 先调 `scripts/idea2design.js` 把想法编译成 design JSON，再走同一条流水线，全程零人工。

### 实测时长

同一个设计（`designs/d1-sht30.json`，3 器件 / 11 连接 / 声明板框 800×600 mil）跑了两次：

| 产物目录 | `elapsedMs` | 折算 | `generatedAt` |
|---|---|---|---|
| `out\SHT30_I2C_TempHumidity-20261126-050157\_run.json` | 194455 | **194.5 秒** | 2026-11-25T21:08:54.684Z |
| `out\SHT30_I2C_TempHumidity-20261126-084306\_run.json` | 120812 | **120.8 秒** | 2026-11-26T00:47:09.760Z |

两次结果：`ok: true`、`gates.drcPassed: true`、`gates.drcLeafCount: 0`、`gates.exportsOk: 6` / `exportsTotal: 6`。都测于各自 `_run.json` 的 `generatedAt`。

**时长会随设计复杂度大幅变化，也会随同一设计的不同次运行波动。** 上面同一块板两次差 1.6 倍。别把 194.5 秒当成整套流水线的常数；`core/ops.mjs` 对 `build` 的自述是「2–20 分钟」，`run-all.ps1` 的默认预算是 530 秒（`run-all.ps1:71`）。

`-Idea` 路径还要先加一次 `scripts/idea2design.js`（一条 Node 命令，几秒级）；上面的计时不包含它。

### 产物长什么样

落到 `out\<设计名>-<yyyymmdd>-<hhmmss>\`：

| 文件 | 内容 |
|---|---|
| `Gerber.zip` | 打样用的 Gerber |
| `BOM.xlsx` | 物料表 |
| `PnP.csv` | 贴片坐标 |
| `Netlist.json` | 网表 |
| `TestPoints.csv` | 测试点 |
| `Board.pdf` | 板图 PDF |
| `_run.json` | 本轮摘要（耗时、板框、gates） |
| `_log.json` | 本轮日志事件（体积大，不要整份读） |
| `_pipeline_rev.txt` | 本轮用的流水线版本（`sha256_12`） |

## 4. 怎么判断成功

三个问题，不要合并成一个「成功」。

| 层 | 问题 | 怎么读 | 判据 |
|---|---|---|---|
| 1 | 文件留下来了？ | `out\<dir>\` 里 6 个产物文件在；`_run.json.ok == true` | 流水线自己跑完了 |
| 2 | DRC 干净？ | `_run.json` 的 `gates.drcPassed == true` 且 `gates.drcLeafCount == 0` | EDA 自己的 DRC 没报叶子 |
| 3 | **能下单？** | `node cli/pcb.mjs fabcheck out\<dir>` 的**退出码** | 0 = 能下单 |

```powershell
node cli/pcb.mjs fabcheck "out\SHT30_I2C_TempHumidity-20261126-084306"
```

第 3 层是**唯一**权威，前两层都不是。

- 第 1 层与第 3 层不是一回事。实测 56 个目录（settle 180 s，测于 2026-11-26 10:08 +08:00）：`ok = true` 的 48 个**全部**可下单（危险方向 0 次），但可下单总数是 53 —— 多出的 5 个来自 `ok = false` 的目录。两个 48 相等是巧合，集合不同。
- 第 2 层也不够。DRC 通过不等于可制造：`fabcheck` 还查铜厚、图元数量、板框自洽、Gerber 可解析性等 EDA 的 DRC 不管的项。

要看「文件之间是否自洽」，还有第四层：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File verify-delivery.ps1
```

20 组判据，退出码 0 通过 / 1 判据没过 / 2 没能测量。`2` 与 `1` 的处置相反，别混。

### 读 `fabcheck` 的正确姿势

它的输出里 `"id"` 这个键出现在 **4 个数组**（`blockers` / `warnings` / `notes` / `passes`），每个结果条目恰好一个 `id`。用正则数 `"id"` 数到的是四个数组的总和，不是阻断数。

```powershell
node scripts/fabcheck.js out\<dir> | ConvertFrom-Json | Select-Object -ExpandProperty blockers
```

`cli/pcb.mjs fabcheck` 打的是**摘要对象**（`blockerIds` 是数组，`blockers` 是拼接好的字符串），`scripts/fabcheck.js` 打的是**完整对象**（四个数组）。两个入口形状不同，别混着取。

## 5. `.pipeline.lock`

### 它是什么

仓库根的一个 `key=value` 文本文件，三个字段：

```
pid=39144
start=2026-11-26T18:50:13.5757228+08:00
design=designs\mic-esp32s3-v4.json
```

只有一份 EDA headless session，所以所有 `run-all` 共用同一把锁。并发跑会互相污染：实测并行跑 d2/d6 时表现成「失败」，串行则全过。

### 怎么用

| 想知道 | 怎么做 |
|---|---|
| 有没有人在跑 | `Get-Content .pipeline.lock`，文件存在且有内容 = 有人在跑 |
| 跑了多久 | 比 `start=` 与当前时间 |
| 在跑哪个设计 | 读 `design=` |
| 有几块板在跑 | `Get-CimInstance Win32_Process -Filter "Name='lceda-pro.exe'" \| Where-Object { $_.CommandLine -match '--owner' } \| Measure-Object` —— 只数带 `--owner` 的 |

### 谁写、谁删、多久算陈旧

`run-all.ps1` 自己管（`run-all.ps1:244`）：

- **抢锁**用 `[IO.File]::Open(..., FileMode::CreateNew, ...)` —— 原子创建，抢不到直接抛异常，天然互斥。抢不到就每 10 秒重试，最多等 90 分钟。
- **释放**在 `finally` 里删文件（`run-all.ps1:283`）。
- **陈旧锁**判定两条任一成立：`Get-Process -Id <pid>` 找不到该进程，或锁文件 mtime 超过 90 分钟。判定陈旧才删。

### 为什么绝对不能用 `os.kill(pid, 0)` 探测存活

Windows 上的 CPython 里，`os.kill(pid, 0)` 不是「发信号 0」，它走 `TerminateProcess(handle, 0)` —— **会真的把持有锁的那个进程杀掉**，退出码 0，看起来像正常退出。

一个只读的「看一眼有没有人在跑」动作，代价是杀掉别人跑到一半的构建，而且现场看起来毫无异常。所以 `core/ops.mjs:199` 的注释把这条钉死了：**只比时间戳**，绝不探测 pid 存活。`readLock()` 只解析 `pid` / `start` / `design` 三个字段，把 `start` 转成 epoch 秒，不做任何进程操作。

## 6. 已知失败模式

来自 `docs/FAILURES.md` 的实测记录（27 条结论，22 真 / 3 部分真 / 2 假）。下面挑的是**复现时会直接踩到**的那些。

| 症状 | 真相 | 位置 |
|---|---|---|
| 「再试一次会更好」，于是重跑 | **错。** 重试阶梯 `smart-fit → expand-1.25x → retry → retry2` 会让结果变差：有设计第 1 次 1 个 DRC 组，第 4 次变 2 个组、SMD 违规从 1 涨到 46 | `docs/FAILURES.md` 第 11 条 |
| 扩板重试后 DRC 一模一样 | 器件坐标被 `_placement` 钉死时，`outlineFit` 走 `explicitFixed` 分支，只放大板框不动器件 —— 几何上不可能改变任何一条违规。实测面积 +56%、直方图逐位相同 | `docs/FAILURES.md` 第 26 条 |
| 布线「布不通」但作业报完成 | 变体阶梯按**作业自报 state** 判去留，而布线器把「这份配置布不通」报成 `completed`。7 份配置里 5 份从来没被执行过（132 个目录 0 次） | `docs/FAILURES.md` 第 16 条 |
| 换了板框但 `_run.json` 没变 | `_run.json.boardWidthMil/boardHeightMil` 写的是**布局前**的声明板框，扩板后从不回写 | `docs/FAILURES.md` 第 10 条 |
| `census` 报出漂亮的通过率，但本机没产物 | 那是磁盘上的旧快照在冒充现在。看 `source` 字段：`live` = 刚真扫过，`snapshot` = 脚本没写新报告 | `AGENTS.md:113` |
| `census` 的 `dirs: 0` 被读成 100% | `0` 是**没有样本**，不是全部通过 | `docs/ARCHITECTURE.md` 第 12 节 |
| 测到的「在飞」目录是上一次的残留 | settle 窗口短于一次尝试。一次尝试可能 400 s，常见 settle 是 180 s | `AGENTS.md:108` |
| 一次 6/6 产物齐全的构建被判成 `NON_JSON` 并整轮重跑 | `2>&1 \| Out-String` 把 stderr 并进了 JSON。已修：stdout/stderr 分开取、强制 UTF-8、整体解析失败时抠最外层 `{...}` 再试 | `docs/FAILURES.md` 第 21 条 |
| 想比较两轮遥测，第一轮的不见了 | 改名块写在 `ConvertFrom-Json` **成功之后**的分支里；失败那一轮被下一轮同名覆盖。一次失败会连带销毁它自己的证据 | `docs/FAILURES.md` 第 25 条 |
| 正则数 `"id"` 得到「十几条阻断」 | `"id"` 是四个数组的总和。干净板子上会数出十几条，而阻断数是 0 | `docs/FAILURES.md` 第 14 条 |
| 文档里的 `文件:行号` 全错但闸门全绿 | `doc-refs` 只判「被引用那一行非空」。插 70 行后它照样 PASS | `docs/FAILURES.md` 第 24 条 |

另外三条会让人得出错误结论，但不报错：

- `fabcheck.js --quiet` 只打一行摘要，**不是 JSON**，别拿去 parse。
- `fabcheck.js --selftest` 需要一个位置参数（好样本目录），不给会崩。
- `out\` 会被自动清理（`run-overnight.ps1` 每 3 轮跑一次 `scripts\cleanup.ps1`，保留最新 40 个 + 每个设计名最新 1 个）。**不要把唯一副本放进 `out\`。**

## 7. 五分钟自检清单

| 步骤 | 命令 | 期望 |
|---|---|---|
| 1 | `node --version` | ≥ 18.17 |
| 2 | `node cli/pcb.mjs list` | 退出 0，列出 5 个操作 |
| 3 | `node cli/pcb.mjs idea-to-design "做一个 SHT30 温湿度采集板" --dry` | 退出 0，打印器件/连接/网络数 |
| 4 | `node cli/pcb.mjs fabcheck examples/d1` | 退出 **1**（样例板有阻断，这是对的） |
| 5 | `node test/smoke.mjs` | 退出 0（契约层自检，零依赖、不碰 EDA） |
| 6 | `Get-Content .pipeline.lock` | 没有文件 = 没人占着 EDA |
| 7 | `pwsh -NoProfile -File .\run-all.ps1 -Design designs\d1-sht30.json` | 退出 0 = 全绿；耗时数分钟 |
| 8 | `node cli/pcb.mjs fabcheck out\<新目录>` | 退出 **0** 才算能下单 |

第 5 步会写盘一次：`census` 的 live 扫描会重写 `out/_probe/fab-census.json`，测试会在跑前存下、跑后原样写回，并断言字节完全相同。所以对外净变化为零。
