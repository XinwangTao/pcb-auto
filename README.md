# pcb-auto · 想法 → PCB 全自动流水线

> 目标：**一句中文想法 → 可打样 PCB**（Gerber/BOM/PnP/DRC 全绿），零人工干预。
>
> ```powershell
> pwsh -NoProfile -File .\run-all.ps1 -Idea "做一个 SHT30 温湿度传感器，带 LED 指示和排针引出"
> ```
> 已实测跑通：想法 → 7 器件 → PCB DRC 0 违规 → 6 个可下单文件，66s，全程无人工。

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-stdio%20server-blueviolet.svg)](mcp/server.mjs)
[![Platform](https://img.shields.io/badge/platform-any%20OS%20%7C%20build%3A%20Windows-lightgrey.svg)](#每个操作需要什么)

**中文** | [English](README.en.md) | [演示片（31.6s）](https://github.com/XinwangTao/pcb-auto/releases/download/v1.0.0/ai-pcb-v9.mp4)

> **演示片里的画面不是动画示意** —— 每一帧都是嘉立创 EDA 画布上**真实生成的几何**：
> 流水线在 9 个里程碑调用 EDA 自己的 `getCurrentRenderedAreaImage()` 取回画布图像，
> 依次是 原理图连线 → 导入 PCB → 自动布局 → 覆铜 → 自动布线 → 收尾。
>
> 也说清它**不是**什么：**这不是桌面录屏**，是 EDA 自己渲染的画布帧。11 段全部落在
> [`video/public/v7/real/`](video/public/v7/real/)（受跟踪），`manifest.json` 里每段都记着
> 来源的批次/尝试/帧文件名，可逐段回溯到 `out/frames/` 的原图。
> 想看真正的桌面录屏，仓库里另有 6 段 gdigrab 录像在
> [`video/public/real/`](video/public/real/)（V6 那版用的；「录屏」这个词只对那 6 段成立）。
> 这两者我先前混说过一次，[`video/README.md`](video/README.md) 里有逐条对照。

---

## 一条命令接入任何 Agent（不必为每个平台写适配）

五个操作只在一处实现（[`core/ops.mjs`](core/ops.mjs)），下面是薄壳：

| 接入方式 | 路径 | 适用 |
|---|---|---|
| **CLI**（零依赖） | [`cli/pcb.mjs`](cli/pcb.mjs) | **任何**能执行命令的 Agent |
| **MCP 服务器**（零依赖） | [`mcp/server.mjs`](mcp/server.mjs) | **任何** MCP 客户端 |
| DSH 插件（Cordis bundle） | [`plugin/`](plugin/) | DeepSeek Harness |
| Claude Code 插件 | [`.claude-plugin/`](.claude-plugin/) + [`.mcp.json`](.mcp.json) | Claude Code |

```bash
node cli/pcb.mjs idea-to-design "做一个 SHT30 温湿度采集板，I2C 经排针引出" --dry   # 想法 → 设计 JSON
node cli/pcb.mjs list                    # 5 个操作自描述
node cli/pcb.mjs fabcheck examples/d1    # 退出码就是答案
node install/install.mjs --list          # 19 个客户端的接入方式
```

**「支持任何平台」说的是接入协议，不是运行依赖 —— 这两件事别混。**

### 每个操作需要什么

| 操作 | Node 下限 | 还要装什么 | 哪能跑 |
|---|---|---|---|
| `idea-to-design` | ≥ 18.17 | 无 —— 只用 Node 内置模块 | 任何系统（CI 的 `ubuntu-latest` job 在跑它） |
| `fabcheck` | ≥ 18.17 | 无 —— 只用 Node 内置模块 | 任何系统（同上） |
| `census` | ≥ 18.17 | Python 3（命令名 `python`；不在 PATH 上就用 `PCB_AUTO_PYTHON` 指路） | 任何系统 |
| `verify` | ≥ 18.17 | PowerShell 7（`pwsh`）+ Python 3（全判据含普查时要） | 任何装了 `pwsh` 的系统 |
| `build` | ≥ 18.17 | PowerShell 7 + 嘉立创 EDA Pro **4.1.111** | **仅 Windows** —— 它驱动 `lceda-pro.exe` 做布局布线 |

**`package.json` 里没有 `"os"` 字段。** 原来那行 `"os": ["win32"]` 是过宽的声明：它把 `build` 的依赖
说成了整个包的依赖，于是 Linux/macOS 用户连 `fabcheck` 都装不上。现在只留真实的那条约束
`"engines": { "node": ">=18.17" }` —— `core/ops.mjs` 的 `run()` 用 `AbortSignal.any`
（Node 18.17 / 20.3 起才有），所以下限是 18.17 而不是 18.0：18.0–18.16 会在第一次跑子进程时抛 `TypeError`。

所以：**把想法编译成设计、检查一块板能不能下单、复算打样率**，在 macOS / Linux / CI 上都做得到
（CI 就在 `ubuntu-latest` 上跑这几个操作的契约测试）；**从零画出一块板**那一步要 EDA + Windows。
这不是适配问题，是依赖问题。

`build` 在缺 EDA 的机器上退 **2**（「没能运行」）并告诉你去装什么，不会退 1（「跑完了但没全绿」）——
后者会被读成「这块板有问题」，而真相是「这台机器没有画板的工具」。

**完整平台清单（含验证等级）见 [docs/SUPPORT.md](docs/SUPPORT.md)** —— 覆盖 Claude Code、Cursor、
Windsurf、VS Code Copilot、Zed、Cline、Codex CLI、Gemini CLI、OpenHands、Goose、DSH、通义灵码、
CodeBuddy、Trae、豆包 MarsCode、智谱、Kimi、星火… 以及所有 MCP / shell 客户端。

之所以不需要逐个适配：**MCP 和 CLI 是协议，不是平台**。任何符合 MCP 2025-06-18 的客户端，
今天就能用，不需要我发布新版本。

## 实测数字（带分母和时刻，可自己重算）

测于 **2026-11-26 10:08 +08:00**，settle 窗口 180 s，重算：

```bash
node cli/pcb.mjs census --settle 180
```

| 指标 | 值 | 分母 |
|---|---|---|
| 已沉淀产物目录 | **80** | 带 `_run.json`、0 个在飞、settle 180 s |
| 可下单（`fabcheck` 退出码 0） | **54** | / 80 = 67.5 % |
| 有阻断 | **26** | / 80 = 32.5 % |
| 自评通过（`_run.json.ok`） | **53** | / 80 |
| 自评通过且真的可下单 | **53** | / 53（危险方向分歧 **0**） |
| 自评失败但其实可下单（悲观方向） | **1** | / 27 |

> 测于 **2026-11-27T10:03:46Z**（`census --settle 180`，`source=live`）。
> 阻断里最大的一类是 `drc.leaves.open × 26` —— 这一条是**新加的**：
> 以前 `fabcheck` 根本不读 DRC，26 块有 DRC 叶子的板能拿到 PASS（见下方注）。

> **分母会变。** 同一个 `out\` 在 settle 0 / 180 / 实时扫描下给出三个**都成立**的目录数。
> 所以引用这个数字必须带时刻和窗口 —— 否则它不是记录，是口号。

**为什么不拿 `_run.json.ok` 当结论**：它回答「流水线跑完了没有」，`fabcheck` 回答「这些文件能打样吗」。
这 80 个目录里两者在**危险方向分歧 0 次、悲观方向 1 次**。那是一次测量，不是保证 —— 能不能下单，永远看 `fabcheck` 的退出码。

> **2026-11-27 修掉的一个洞**：`fabcheck` 以前**完全不读 DRC**，只拿 `_run.json` 核对板框尺寸。
> 于是 26 块「自述 DRC 还有叶子」的板拿到 `verdict: PASS`。现在自述有叶子即阻断
> （`drc.leaves.open`，**单向**：只用「有」否决，绝不用「没有」背书），并且每次输出都带一条
> `scope.electrical` 明说「本闸门不查电气间距/短路/连通性」。
> 语料面影响：**26 / 70 个有 DRC 读数的目录从 PASS 改判 FAIL**。详见
> `out/_probe/FABCHECK-NEVER-READ-DRC.md`。

## 已知限制

1. **没有任何一块板被真正制造过。** 所有「可打样」都是文件层面的判断，不是「焊出来能用」。
2. **`build` 仅 Windows。** 它依赖 PowerShell + 一个 Windows-only 的 EDA 服务端进程（`lceda-pro.exe --owner`）。
   其余四个操作不挑系统 —— 但它们只覆盖「设计 / 检查 / 统计」，画不出一块新板。
3. **仅嘉立创 EDA** 一家厂商。
4. **自动布线不够可靠**：44 个板名里 2 个（4.5 %）从未产出可下单目录。
   重试阶梯（换更大的板框）**经常让结果更差** —— 有设计从 1 个 DRC 组变成 2 个、SMD 违规从 1 涨到 46。
5. **文档里有 13 个已确认的错误**（6 处在网页、7+7 处在交付 README）。
   没有偷偷改掉，而是逐条公开在 `交付-README.md` 的「已知限制」里，并写明理由。
6. 本仓库**不主张**任何 star 数、下载量或用户评价。
7. **电气判据不在 `fabcheck` 里。** —— 这是一条**口径**，不是遗憾：
   - **电气间距 / 短路 / 网表连通性** → 由 EDA 自己的 DRC 与独立复核
     [`scripts/verify-drc.js`](scripts/verify-drc.js) 负责（后者在全新 headless 会话里重建覆铜后重查）；
   - **产物可制造性**（层/孔/栏栅/比例/板框/坐标合法性）→ `fabcheck`；
   - **能不能下单** = 两者的**合取**（`run-all` 的 `$finalOk`）。

   `fabcheck` 的输出里永远带一条 `scope.electrical`，写明它不查那三件 ——
   **所以它的 `PASS` 不能被读成「没有短路」**。反过来，若流水线自述的 DRC
   还有叶子，`fabcheck` 现在会直接阻断（`drc.leaves.open`，单向：只用「有」否决，
   绝不用「没有」背书）。这一条是 2026-11-27 补的：此前 `fabcheck` **完全不读 DRC**，
   26 块自述有叶子的板拿到了 `verdict: PASS`。详见 `out/_probe/FABCHECK-NEVER-READ-DRC.md`。
8. **布局器的尺寸表是「碰撞盒」而不是焊盘跨距**：`scripts/relayout.mjs` 的 `SIZES`
   必须 ≥ 成品实测铜范围（它还要盖住本体），这条不变量由第 23 关钉着。

**凭什么说这个更好、以及我哪里不如别人：[docs/WHY.md](docs/WHY.md)。**

**怎么把 LCEDA Pro 的 CLI 逆向成可被程序驱动的：[docs/REVERSE-NOTES.md](docs/REVERSE-NOTES.md)。**
里面写的是文档里没有、报错信息还会把你带错方向的东西：静默失败、必须遵守的调用顺序、
画布单位 = mil/10、SVG 与笛卡尔坐标的 y 翻转，以及**那些根本不存在的方法名**
（省得你先试 `getBBox` 再发现它在 `SYS_Math` 上）。
每条结论都附了可自己跑的 `grep` 命令。

离线 API 参考已经入库：[`api/`](api/) —— 584 个类型 / 108 个可调用类 / 793 个方法。
故意做成离线的：不连服务、不截图、不问客服。

---

## 独立校验：不信任流水线自述

**核心原则：`DRC 通过` ≠ 板子是对的。** `scripts/verify-artifacts.js` 只读 `out/<run>/` 下的产物文件
和设计意图做交叉核对，并在自愈循环里参与判定：

| 校验项 | 判据 |
|---|---|
| 器件完整性 | 每个 `(des, lcsc)` 在 `Netlist.json` 里，型号一致；无多余器件 |
| 网络连通性 | 设计每条 `(des, pin, net)` 与 `pinInfoMap[*].net` 逐条对上 |
| BOM | **按物料合并**，判据是 `Quantity` 求和 == 器件数、位号集合一一对应 |
| PnP | 条数 == 器件数；坐标跨度在板框内；无器件完全重合 |
| **Gerber 铜含量** | 解析 GTL/GBL 统计 `D01/D03` 图元与铜区数 —— **<20 个图元判为零铜** |
| Gerber 层 | 8 个必需层 + ≥2 个钻孔文件 |
| 板框 | GKO 有绘制指令（闭合） |

实测这条校验抓到了一个**流水线自己看不见的严重缺陷**：
板框 200×200 时流水线报 `ok=True / DRC=0`，但放大到 2194×1675 后**底层铜只有 9 个图元（近乎零铜）**
—— 若只信自述，这个空板会被当成功交付。现在它会触发自愈重试，放大到 3291×2512 后通过。

```powershell
node scripts\verify-artifacts.js --latest designs\d6-rp2040-minimal.json
node scripts\verify-artifacts.js out\<run-dir> designs\<design>.json
```
退出码 0 = 通过。反证：把设计里任一连接的网络名改错，校验器立即报 `X.n 期望 A，实际 B` 并 exit 1。

> 板框以产物目录的 `_run.json` 为准（流水线落盘的实际生效值），因为自愈会放大板框，
> 设计文件里的原值已不代表本次实际使用值 —— 这个归属搞错会导致校验误判。

## 电气合理性检查（17 项校验的第 15–17 项）

**产物齐全 + DRC 全 0，仍然可能是块废板。** 这层检查抓到了 3 个真实设计缺陷：

| 设计 | 缺陷 | DRC 报了吗 |
|---|---|---|
| d2 / d3 | SHT30 的 **SDA/SCL 引脚完全没接**，上拉电阻连到悬空网络名 | 否 |
| d6 | RP2040 的 **QSPI 六线全悬空**（无 Flash 无法启动）、RUN 无上拉 | 否 |

判据（只读 `Netlist.json`，**既不看设计文件也不看流水线自述**）：
1. 必须有地网络，且连接点 ≥2
2. 电源网络连接点 ≥2（1 个 = 悬空电源）
3. 每个信号网络连接点 ≥2（1 个 = 半截网络）
4. 多脚 IC 接了电源却完全没有地 → 疑似封装映射错误

关键点：前面 14 项是「设计说的 vs 产物做的」一致性核对，两者一致就 PASS ——
但**设计本身可能是错的**。所以必须再加一层与设计无关的自洽性检查。

负向验证：手工把某网络砍到只剩 1 点，校验器独立报
`电气：1 个信号网络只连了 1 个点（半截网络）: LED_A(D1.1)`。

## 板框面积优化：只能在布局前缩，不能布局后剪

板框尺寸是按 `$estArea = compCount*120000 + connCount*12000` **估**出来的，宁大勿小。
但估大了器件就挤在中间、四周大片空白 —— 面积虚高、打样多花钱、看着不专业。

实测 d6：估出 4716×3600，实际器件只占 717×2167，**填充率仅 0.09**。

### 死路：布局后剪板框

试着在 `autoLayout` 之后把板框收到器件外框 + 余量，结果 **68 个网络全部断开**：

```
Connection Error | Common | (GND): C4_2   ← 每个焊盘都"未连接"
```

原因：布局引擎按大板框把器件排成**细长条**（span 717×2167），剪成 1237 宽后
扇出空间不足 → 布线产出的走线被 `fixClearance` 全部删除 → 只剩覆铜。
把余量从 120 提到 260 mil 仍然全断。**问题不在余量，在顺序。**

### 正解：布局前用小板框重跑

`run-all.ps1` 里加 `compact-fit` 阶段：首轮通过独立校验后，
若 `outlineFillRatio < 0.5`，按 `sqrt(fillRatio)×1.15` 收缩初始板框**重新跑一遍**
（至少不缩到 0.45 以下）。紧凑方案也须通过 17 项校验且面积更小才替换正式产物，
否则保留原方案 —— 紧凑版先输出到 `out/.../compact/` 子目录，不会覆盖已验证的产物。

d6 实测效果：

| | 板框 | 面积 | 校验 |
|---|---|---|---|
| 原方案 | 3144×2400 | 7,545,600 mil² | 17/17 |
| **compact-fit** | **2123×1620** | **3,439,260 mil²** | **17/17** |

省 54% 面积，顶层铜图元 2084→2369、铜区 50→46，布线更紧凑且 DRC 仍为 0。

## 并发保护：全局锁

所有 `run-all.ps1` 共用同一个 EDA headless session，**并发跑会互相污染**。
实测：并行跑 d2/d6 时报"失败"，串行则全过 —— 这种假失败在长期无人值守下极难排查。

现在 `.pipeline.lock` 做原子互斥（`FileMode::CreateNew`），抢不到就每 10s 重试，
并有陈旧锁清理（持有进程已退出 / 超过 90 分钟）。`finally` 保证必释放。
→ 可以放心并行启动多个任务，它们会自动排队。

## 原理图网格随器件数自适应

原来固定 4 列 / 间距 160×150，14 个器件会纵向溢出图页触发 `OBJECTOUTSIDESHEET`
（导致 `schDrcErrors` 非 0、DRC 阶段根本没跑）。现在列数按
`min(7, max(4, ceil(sqrt(n×1.4))))` 自适应，间距 `min(160, 1050/列数)`。

## 长期无人值守

```powershell
pwsh -NoProfile -File .\run-overnight.ps1 -Until "2026-11-26 10:00"   # 跑到指定时间
pwsh -NoProfile -File .\run-overnight.ps1 -Rounds 5                   # 只跑 5 轮
```

每轮遍历 `designs\d*.json` 全跑一遍（含自愈 + 独立校验 + 全局锁），
结果写 `logs\overnight-<stamp>.log` 与 `logs\overnight-summary.json`。
单次失败不中断；**连续 3 轮全盘失败才停下**（避免空转烧资源）。

### 自动清理（必需）

实测跑 3 小时就积累 **143 个 out 目录(52MB) + 191 个 EDA 工程(112MB)**、进程内存 5.3GB。
20 小时不清理会到 GB 级并拖慢 EDA。守护循环每 3 轮自动调 `scripts\cleanup.ps1 -Apply`。

```powershell
pwsh -NoProfile -File .\scripts\cleanup.ps1          # 预演，只报告不删
pwsh -NoProfile -File .\scripts\cleanup.ps1 -Apply   # 真删
```

安全策略：默认预演；**每个设计名保留最新 1 份产物**便于复查；
EDA 工程只删 `AI_*` 前缀（用户自建工程绝不触碰）；保留最近 10 个 AI 工程。
实测一轮释放 136 MB（out 52→16.5MB，工程 112→11.9MB）。

### session 自恢复

`.session` 里的 id 失效时会自动检测并重建 headless session（实测篡改成无效 id 后
自动新建并继续跑通）。新 session 冷启动时首次布局可能失败一次，自愈机制会兜住。

## 当前状态（2026-11-27 10:52）

| # | 设计 | 器件 | 网络 | 器件品类 / 复杂度 | PCB DRC | 耗时 |
|---|------|------|------|------------------|---------|------|
| d1 | SHT30 温湿度 | 1 | 3 | IC | **0 违规** | 47.0s |
| d2 | SHT30 完整模块 | 4 | 4 | IC + 阻容 | **0 违规** | 60.3s |
| d3 | SHT30+LDO+LED | 9 | 6 | IC + 阻容 + 双电源域 | **0 违规** | 54–69s |
| d4 | SHT30+8P 排针 | 5 | 4 | IC + 阻容 + **连接器** | **0 违规** | 61.1s |
| d5 | LED 指示灯（纯分立） | 5 | 4 | 无 IC，纯分立器件 | **0 违规** | 61.4s |
| d6 | RP2040 最小系统 | 12 | 27 | 57 脚 QFN + 4 电源域 + 9 GND + QSPI + USB 差分 + SWD | **0 违规** | 77.6s |
| **d7** | **RP2040 + QSPI Flash** | **10** | **12** | **RP2040 ↔ W25Q16 六线 QSPI 总线 + 双电源域** | **0 违规** | 83.3s |
| gen-rp2040-v2（想法生成） | 14 | 16 | 一句话 → RP2040+Flash+LDO+USB+LED | **0 违规** | 81.9s |

- 一条命令跑全量：`pwsh -NoProfile -File .\run-batch.ps1` → **7/7 通过**
- 稳定性：d3 连跑 3 次，pass/DRC 策略完全一致（67–69s）
- **规模上限已验证到 RP2040 + 外挂 Flash（14 器件、58 连接、16 网络）** —— 真实量产级复杂度
- 全部 7 个设计**同时通过 PCB DRC 0 违规 + 14 项独立产物校验**

### 最新一轮：ESP32-S3 无线麦克风（28 器件 / 115 连接 / 27 网络）

| 测量 | 结果 | 说明 |
|---|---|---|
| `_run.json.ok` | `true` | 流水线**自述**跑完，不是下单判据 |
| PCB DRC 叶子 | **0** | `drcLeafCount.passed = true` |
| 独立 DRC 复核 | 通过 | `_gates.independent.json` 六道闸门全 `true`；该文件由 **`run-all.ps1`（运行器，独立进程）** 写 |
| 独立产物校验 | **19 / 19** | 只读导出文件，不复用流水线结论 |
| `fabcheck` | exit 0 / PASS / **0 阻断** | **唯一的下单权威** |
| 耗时 | **410 s** | attempt 1 一次过，未走重试阶梯 |

产物：`out/ESP32S3_Wireless_Mic_V5-20261127-005256/`（Gerber.zip / BOM.xlsx / PnP.csv /
Netlist.json / TestPoints.xlsx / Board.pdf + 打样清单 / 装配说明 / 成本估算）。

四个测量的**分工**必须说清：`ok=true` 只说"流水线跑完了"；`fabcheck` 才回答"能不能下单"；
两者都不回答"焊出来能不能用" —— **没有一块板被制造过**。

### 演示视频

**[演示片 docs/media/demo.mp4](docs/media/demo.mp4)**（720×1280 / 1.9 MB） —— 27.0 s / 1080×1920 / 810 帧：

- 8 段**全部是真实屏录**，没有一张静态截图
- 倍速 **2×–32×**（实测 8 段：5/3/2/32/7/3/3/3） 用 `setpts` 烘进文件（屏幕写的倍速 = 文件实长，不是两套账）
- 首尾全窗 EDA 界面，AI 在操作的 6 段**自动放大到板子**（面积 9.89×）
- 8 句中文配音 + 硬字幕

可复现：`pwsh -File video\scripts\make-v11.ps1 -Batch <HHmmss>`，配方见
[`video/CAMERA-RECIPE.md`](video/CAMERA-RECIPE.md)。

### 这个项目到底怎么工作

→ [`docs/PROJECT-STORY.md`](docs/PROJECT-STORY.md)：AI 如何通过 JS API 无窗操作 EDA、
为什么这块板难、这一轮修掉的三个结构性缺陷、16 道闸门的验证方法、以及边界。


### 自愈机制
`run-all.ps1` 内置失败自动重试：`smart-fit` → `expand-1.5x` → `expand-2.0x` → `expand-1.5x-retry`。
板框过小或器件跨度超出板框时，布线器会**静默放弃**（1.2s 返回 `completed` 但零铜）——放大板框即可救回。
`smart-fit` 先按 `器件数×120000 + 连接数×12000` 估面积，给足 1.9x/1.45x 宽高冗余，实测能让 RP2040 首轮即通过。报告里显示实际生效策略。

### 器件可信度分级
- `errors`（阻断）：查不到 LCSC 器件 —— 拿不到 symbol/footprint，流程无法继续。
- `warns`（不阻断）：社区上传件无原厂/datasheet（连接器常见）—— 流程照跑，报告提示下单前人工复核。

## 一条命令

### 从一句中文想法直接出板（推荐）
```powershell
cd pcb-auto
pwsh -NoProfile -File .\run-all.ps1 -Idea "做一个 SHT30 温湿度传感器，带 LED 指示和排针引出"
```
`-Idea` 会先调 `scripts/idea2design.js` 把想法编译成 design JSON，再走同一条流水线，全程零人工。

### 从现成 design JSON 出板
```powershell
pwsh -NoProfile -File .\run-all.ps1 -Design designs\d3-sht30-ldo.json
```

产物落到 `out\<name>-<timestamp>\`：`Gerber.zip`、`BOM.xlsx`、`PnP.csv`、`Netlist.json`、`TestPoints.csv`、`Board.pdf`。
退出码 0 = 全绿。日志 JSON 在 `logs\`。

## 想法 → 设计：`scripts/idea2design.js`

不做「凭空生成」，而是**基于已实测通过的配方做模式匹配 + 参数填充**：

```
自然语言 ──关键词──> designs/_catalog.json 里的真实器件 ──配方──> design JSON
```

- `designs/_catalog.json` — 14 条真实器件，每条都经 `lib_Device.getByLcscIds` 校验存在，带 `trusted`/`designator`/`pins`/`netHints`
- 三套配方：**RP2040 系统**（自动展开全部电源域/GND/QSPI/USB/SWD）、**传感器模块**（I2C 上拉+去耦，可选 LDO/LED/排针）、**纯分立**
- 位号用目录里的真实前缀递增（注意连接器是 `H` 不是 `J`）
- 认不出器件时**明确失败**（exit 1），不瞎编

```powershell
node scripts\idea2design.js "做一块 RP2040 主控板，USB 供电，带 LDO 稳压和状态指示灯" --dry
```
实测：RP2040 想法 → 13 器件/56 连接/16 网络 → PCB DRC 0 违规（79.3s）。

> 扩展方式：往 `_catalog.json` 加一条器件（lcsc + pins + tags），关键词表里加一条正则即可。
> 不要用 `lib_Device.search` —— 它在 4.1.111 上对所有查询都抛 `Cannot read properties of undefined (reading 'lists')`。


## 设计格式 `designs/*.json`

```json
{
  "name": "工程名",
  "boardWidthMil": 1000, "boardHeightMil": 800,
  "components": [{ "des": "U1", "lcsc": "C86346", "value": "SHT30" }],
  "connections": [["U1", "5", "VDD"], ["U1", "8", "GND"]]
}
```
`connections` 是 `[位号, 引脚号|引脚名, 网络名]`。只写要连的引脚，不连的留空。

## 8 条硬约束（踩过的坑，违反必挂）

1. **工程名必须唯一** — 同名已存在时 `createProject` **静默返回 undefined**，不抛错。流水线已自动加时间戳后缀。
2. **引脚必须按 `side` 引出** — 同边多引脚若都垂直引出，走线重叠会被源数据层合并成同一网络。用 `SCH_SourcePin.getGeometry` 取 `side`。
3. **连通靠「引脚 → 短导线 → 导线端点放网络符号」** — 只放网络符号不连线**完全无效**（引脚仍为 none）。
4. **`Sch*`/`Pcb*` 画布 API 必须先激活文档** — `dmt_EditorControl.openDocument(uuid)` + `waitForDocumentReady`，否则报「请先打开文档」。
5. **GND/电源必须用 `PCB_PrimitivePour` + `rebuildAllCopperRegions()`** — 用 `PrimitiveFill` 只是画了块死铜，**不连网络**；不 rebuild 也不生成铜皮。这是 DFN 散热焊盘（EP）能通的关键。
6. **布线端点有浮点误差** — 极速引擎输出 `363.101` 而焊盘在 `363.3`，DRC 判「未连接」。必须用 `PCB_PrimitiveLine.modify` 把端点吸附到焊盘中心（阈值 1.5mil）。
7. **图元改属性只能用 `modify(id, props)`** — `toAsync()` + `setState_*` + `done()` 会报「对象参数不正确，无法应用到画布」。
8. **DRC 必须显式执行** — `getDrcResult()` 单独调用返回 `state:'notChecked'`。要 `pcb_Drc.check(true,false,true)`（详细树）和 `check(true,false,false)`（布尔）。

## 已实现的自动化修复

- **断连** → 覆铜（GND 两层 + 电源顶层）自动连接同网焊盘
- **浮点端点** → 端点吸附到最近同网焊盘/过孔（1.5mil）
- **间距违规** → 冲突过孔先缩到规则最小值（孔 11.8mil/外径 19.7mil），仍冲突则删除（覆铜保连通）
- **布线不全** → 最多 3 轮「布线 → DRC → 重建覆铜 → 再布」

## 关键 API 速查

| 用途 | 调用 |
|------|------|
| 建工程 | `dmt_Project.createProject(name, null,null,null, desc)` → 64hex |
| 建板 | `dmt_Board.createBoard()`（**无参数**） |
| 放器件 | `sch_SourcePrimitiveComponent.add({projectId,schematicName,pageName,libraryUuid,name,x,y,designator?,properties?})` |
| 引脚几何 | `sch_SourcePin.getGeometry({projectId,schematicName,pageName,primitiveId})` → `side/length/x/y` |
| 画导线 | `sch_SourcePrimitiveWire.add({...,line:[x1,y1,x2,y2],net})` 仅 H/V |
| 放网络符号 | `sch_SourcePrimitiveComponent.addNetFlag({...,type:'Power'|'Ground',net,x,y,rotation})` |
| 覆铜 | `pcb_PrimitivePour.create(net, layer, polygon, 'solid', false, name, prio, lineWidth, lock)` |
| 重建铜皮 | `pcb_PrimitivePour.rebuildAllCopperRegions()` |
| 改图元 | `pcb_PrimitiveLine.modify(id,{startX,startY,endX,endY})` / `pcb_PrimitiveVia.modify(id,{diameter,holeDiameter})` |
| 自动布局 | `pcb_Document.startAutoLayout()` → `getAutoJobStatus(jobId)` |
| 自动布线 | `pcb_Document.startAutoRouting({optimization:ULTRA_FAST, existingPrimitiveMode, engineConfig})` |
| DRC | `pcb_Drc.check(strict, ui, verbose)` |
| 导出 | `pcb_ManufactureData.getGerberFile/getBomFile/getPickAndPlaceFile/getTestPointFile/getPdfFile` |

## 在新机器上部署（先跑这一条）

```bash
git clone <repo> && cd pcb-auto
npm install            # 不装的话契约闸门会**静默跳过**（见下方第 1 条）
npm run doctor         # 把下面四个坑提前查出来
```

`npm run doctor` 检查 10 项，区分「阻塞」与「提醒」（退码 0 可跑 / 1 有阻塞项 / 2 检查器跑不起来）：
Node ≥ 18.17、`acorn`+`eslint-scope`、pwsh 7、git、LCEDA 4.1.111、WMIC、
控制台编码、仓库位置、`.pipeline.lock`、python（可选）。

**四个只有装完才知道的坑**（实测 2026-11-27，一台干净的 Windows，前四次尝试全部失败）：

1. **只 `git clone` 不 `npm install`** ⇒ `staticcheck` 报「解析器不可用，本关跳过」。
   这意味着「返回对象引用了不可见标识符」这类闸门**静默关闭**而没有一处会红。
2. **仓库装在该机写不进去的分区** ⇒ 六个导出全 `ok:false` 却各自带着真实 size，
   跑满 336 秒、产物目录只剩几个文件。EDA 的可写白名单**不写在任何文档里**、各机器不同，
   不要猜规律；先试用户 `Documents` 下（开工前的写盘探针会 5 秒内告诉你是这一类）。
3. **该机没有 WMIC** ⇒ `open --headless true` 报 `SPAWN_OWNER_FAILED`。
   先手动起一次客户端再开 headless：
   `Start-Process lceda-pro.exe` → 等 25 s → `lceda-pro.exe open --headless true` → 把 `sessionId` 写进 `.session`。
4. **中文版 Windows 的控制台编码** ⇒ 子进程中文 JSON 解析失败，被报成「fabcheck 输出不是 JSON」。
   触发条件不是「中文版」本身，而是**进程没有附加控制台或输出被重定向**时落到 ANSI 代码页；
   同一台机器交互时是 utf-8、spawn 出来就是 gb2312。`run-all.ps1` 已自动切 UTF-8。

验收口径：完整跑通一轮应得到 `退出码 0 = 六道独立闸门都测过且通过`，
`_gates.independent.json` 里 `finalOk:true` 且 `exitCode:0`。参考实测：
`out/_probe/INSTALL-ON-ANOTHER-MACHINE.md`。

## 环境

- CLI：**嘉立创 EDA Pro 4.1.111** 的 `lceda-pro.exe`（GUI 与 CLI 是同一个 exe）。
  脚本不写死它的位置，按「环境变量 `PCB_AUTO_LCEDA` → 常见安装位置 → PATH」解析；
  解析不到会直接停下并打印试过的每一条路径。同理 `PCB_AUTO_NODE`、`PCB_AUTO_PYTHON`。
- session id 存 `pcb-auto\.session`；所有调用带 `--ext-uuid eda`
- `--code` 有 32KB 命令行上限 → 一律用 `--code-file`
- PCB 内部单位 **mil**（1mm = 39.37mil）；DRC 规则配置单位却是 **mm**
- PowerShell 抓 stdout 要 `| Out-String`

## 下一步

**还没做到的：**

1. 扩到更多设计：LED 指示灯、按键、稳压器、更多引脚 I2C 器件
2. 排针/连接器类器件（多为社区上传 `C99xxxxxxxx`，需谨慎验证）
3. **让某块板真的被造出来并做电气验证** —— 这是唯一能推翻 NOTICE 里那句
   「没有任何一块被真正制造过」的方式。在那之前所有「可打样」都是文件层面的判断。

**原先列在这里、现在已完成的：**

- ~~Remotion 短片「AI 全自动接管 PCB 设计」~~ → 31.6 秒，已在本页顶部链接到 Release
- ~~关键信息归档 Obsidian~~ → 已完成（归档的是踩坑与判据，不是过程叙述）

## 仓库体积（克隆下来发现很大就看这里）

实测 2026-11-27：通过 `gh-proxy` 克隆下来的 `.git` 是 **65.6 MB**，
而全部历史 blob 合计只有 **25.3 MB**、单个最大文件只有 **1.8 MB**。

差额不是“二进制太大”，是**本地对象库没整理过**：3 个 pack 共 58 MiB + 7.3 MiB 松散对象。

```powershell
git gc --prune=now          # 只整理对象库，不改历史内容
#   实测：65.6 MB -> 11.1 MB（-83%），3 个 pack -> 1 个，松散对象 552 -> 0
#   git fsck --full 无错，74 个提交与 HEAD 不变；克隆下载量 58+ MiB -> 10.9 MB
```

**不需要 Git LFS，也不需要重写历史。** 这个仓库里没有大文件（字体只跟踪了
0.37 MB；配音 wav / 切片 mp4 / 抽帧 png 都在 `.gitignore` 里，它们可以一条命令重跑）。

> 这一条本身就是一个断言：先量“历史 blob 有多大”，再决定要不要 LFS。
> 我一开始把**磁盘占用**当成了**历史占用**报了错数，
> 而按那个错数字上 LFS 会白担重写历史 + 强推的风险，收益为零。

## 许可证与免责

MIT，见 [LICENSE](LICENSE)。许可证**覆盖范围**和「没有一块板被制造过」的免责声明在 [NOTICE.md](NOTICE.md)。

那句免责声明**故意不放在 LICENSE 里**：往 MIT 原文后面追加散文会让 GitHub 的许可证识别器
报 `NOASSERTION`（看起来像「许可证不明」），对想采用这个项目的人是实实在在的劝退。实测踩过。
