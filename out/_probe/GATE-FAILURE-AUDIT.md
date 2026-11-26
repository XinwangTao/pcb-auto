# 7 道闸门「弄坏了会不会红」审计

实测（2026-11-26T18:11:50–18:17:45 +08:00，`E:\APP\nodejs24\node.exe`，7 道全部 exit 0；期间 18:15:26–18:15:47 有另一个写者改了 `scripts/` 下 3 个 md，故 doc-refs 数字以 18:17:45 重跑为准，108/56/16 未变）：syntax 解析 292/644（另 352 无语法）、devpath functional 0 / historical 53 / 35 文件 / 8 豁免全命中、docrefs 108 引用（发布 56，带锚点 16）、capability 9 条（A 查 3、B 查 5 条/15 路径）、smoke 96/96、plugin 10/10、mutants 12/12 但覆盖 12/62。仓库有构建在跑（`.pipeline.lock` pid=44752），census 读数取 18:12:33 live 扫描。

| 闸门 | 断言是什么（比较哪两个东西） | 有负向用例吗 | 弄坏被测物会红吗 | 分母是否诚实 | 读不到输入时 | 判决 |
|---|---|---|---|---|---|---|
| syntax-gate | 文件源码 ↔ 解析器（vm.Script→invoke 体→node --check / Python compile+SyntaxWarning→异常 / pwsh Parser） | 无自建负例。**我实测**：`%TEMP%` 放 `export const = ;` 传具名文件 → exit 1；好文件 → 0 | 会。语法一轮直接红；语义破坏不归它管 | 诚实：292 真解析 + 352 明确「未解析，不算通过」，3 个 WARN 不计入 | 读不到→NOINPUT→**exit 2** | 能失败 |
| dev-path-scan | 6 条正则 × 每个已跟踪∪未跟踪文本文件的每一行；8 条豁免每条必须真命中 | **有，双向**：坏样本必抓到、干净样本必不命中、豁免必判 historical（本次 6/6 ✓） | 会。往非豁免文件写一条裸本机路径 → functional>0 → 1；检测器坏 → 2 | 诚实（0 / 53 / 35 / 8 都分开说） | 非 git → **2** + 可照做处置 | 能失败 |
| doc-refs | `文件:行号["锚点"]` ↔ 文件存在 / 行号 ≤ EOF / 端点非空 / 有锚点时该行含锚点文字 | 有 5 条自检，含 `anchorOk` 的正例与反例（该命中/不该命中） | **半会**：缺文件、越界、空端点、锚点不符 → 红；但**行号整体位移**只有 16/108 有锚点，**发布文档仅 3/56**，其余 53 处移到任何非空行都绿 | **半诚实**：`✓ 发布文档的 56 处…其中 16 处核对了锚点` 把 13 处「记录」文档的锚点算进了发布分母（真实 3/56） | 0 引用 → 归 selfProblems → **exit 1**（把「没样本」报成「发现失败」，违反 0/1/2 契约） | 只在很窄的条件下能失败 |
| capability-gate | `capabilities.json` 自身：A 未验证 level 不得 unattended:true；B verified 的 evidence 非空且路径存在 | 无（C 只验输入形状坏→2，不构造坏能力表） | **不会**。`call_sites` 只是字符串、从不与代码对账；改代码永远绿，只有人把 JSON 写成自相矛盾才红 | 半诚实：A/B 分母（3 / 5）打印了，但**没有断言分母 > 0**；9 条全改 `pilot` 就 GREEN 0/0 且仍 exit 0 | 文件缺/JSON 坏/空表/未知 level → **2** | 只在很窄的条件下能失败 |
| smoke | 96 项：29 条「文件存在且字节>0」+ 9 条 `node --check` + 6 条 `JSON.parse` + 52 条行为差分（CLI 退出码、JSON-RPC、locateRoot、census live/snapshot、缺 git 退 2） | 有，但只钉 4 类分支（git 缺失×3+反向、缺 pwsh/python 的话术、未知参数不被吞）；无「故意弄坏 core」的注入 | 会（改 CLI 退出码 / MCP 输出即红）；但 29 条存在性断言对内容破坏永远绿 | 96 都打印且本次 0 条 SKIP（python/pwsh/git 都在，`18 个脚本（python）`）；但代码里 12 条分支会把「没测」写成 `SKIP…` 仍计入 96 | 多数分支 SKIP 且算 PASS（不沉默，但也不红）；git 缺失由子闸门退 2 并被断言 | 能失败 |
| plugin-harness | plugin apply 后注册的 5 工具 ↔ `core.OPS` 的数量/名字/参数 type+required；另真跑一次 pcb_census 并断言证据文件字节还原 | 无自建负例，靠「两个独立来源对账」 | 会，但**只在两边不同步时**；core 与 plugin 同时丢一个工具仍绿（`want` 是动态的 `Object.keys(core.OPS).length`，「必须 5 个」只由 smoke 钉住） | 诚实：10 项全打印细节（5 工具 / 15 参数 / 19993 B 一字不差） | 证据文件缺失 → 该项直接红，不沉默 | 能失败 |
| mutants | 每条突变的 (fabcheck exit, 输出 id 多重集) ↔ catalog 的 expect；且 mustInclude 的 id 在干净 base 上不能已亮（差分，非空断言） | **有 `--selftest`**（好期望→0、坏期望 `no.such.id`→1），但**不在 `scripts.test` 链上** | 会。fabcheck 丢判据 → 未命中 → exit 1 | 最诚实也最致命：12/12 命中、覆盖 **12/62（19.4%）**，其余 **50 条判据从没被证明能亮**，exit 仍 0 | base 缺/在 out 下/catalog 空/fabcheck 崩 → **2** | 能失败（只对 62 条里的 12 条） |

**判决分布**：能失败 5 道（syntax-gate / dev-path-scan / smoke / plugin-harness / mutants）；只在很窄的条件下能失败 2 道（doc-refs / capability-gate）；**闸门粒度上「实际上永远不会失败」的 0 道**。但「永远绿」的那部分不在闸门粒度上，而在三块主体断言里：doc-refs 的 53/56 发布引用只验非空、mutants 的 50/62 判据从未被证明会亮、capability 的 A/B 全靠分母恰好非零。

## 最该先修的三处

1. **mutants 的覆盖 12/62 不参与判决**。真问题：它自报「哪些判据从没被证明能亮」并给出 19.4%，但 exit 只看 12/12 命中——剩下 50 条判据的「不会失败」就是它的全部产出，正是本仓库最忌讳的形状。最小修法：把 `--selftest` 接进 `scripts.test`，并在 `proven.size < totalSet.size` 时打印未覆盖 id 清单、以非 0 退出（或至少降级成 `COVERAGE=INCOMPLETE` 不算 PASS）。
2. **doc-refs 的锚点覆盖与分母口径**。真问题：`run-all.ps1` 插 70 行、56 处引用全错的原始事故，今天仍有 53/56 发布引用处于「落到任何非空行都算对」；且汇总句把 13 处记录文档的锚点算进发布分母，读者会读成 16/56。最小修法：给 `docs/FAILURES.md` 的 54 处引用逐条补 `"稳定子串"`，把 `anchoredRefs` 拆成 published/record 两个分母并把 `totalRefs===0` 改回 exit 2。
3. **capability-gate 只对账声明、从不看代码**。真问题：`call_sites` 是纯字符串，`waitJob` 明天真去依赖 `canvas_frames_animate_during_routing` 它也不知道；A/B 又能 0 样本 GREEN，等于「0/0 读成 100%」。最小修法：`aCount.checked === 0 || bCount.verified === 0` 直接退 2；A 增加一条判据——`unattended:true` 条目的 `call_sites` 里出现任一 BLOCKING 能力的调用点即红。

## 我核不实的地方

- 除 syntax-gate 那次 `%TEMP%` 注入实测（exit 1）外，**「弄坏会红」全部是读代码 + 差分推理**，没有真去改 `test/` 或 `capabilities.json`（硬约束禁止），所以「实际会不会红」我没有实测证据。
- capability-gate 的 A 能否被代码变更打红：我只读了 `capability-gate.mjs` 与 `plugin-harness.mjs`，**没有全仓确认**是否另有消费方把 `capabilities.json` 与真实调用点对账。
- plugin-harness「证据文件字节还原」只比字节；`out/_probe/fab-census.json` 在两次运行之间是否被在跑的构建（pid 44752）改过，我无法排除。
- doc-refs「位移 70 行仍绿」是按 3/56 锚点推断的，没有实际位移文档做对照实验。
- smoke 的「12 条可退化成 SKIP 却计入 96」是读代码数的分支，本次 0 条走 SKIP，未在缺 python/pwsh 的机器上实测过计数。
- `docs/FAILURES.md` 的 54 处引用在两次 doc-refs 运行里都报 54；我第一次读到的「3 处核对了内容锚点」与随后的「16 处」不一致，最终以重跑输出 16 为准，原因未查清。

STATUS={"status":"ok","changed":["out/_probe/GATE-FAILURE-AUDIT.md"],"verify":{"cmd":"cmd /c \"node test\\syntax-gate.mjs\"","exit":0},"reason":"7 道闸门全部实测 exit 0：能失败 5 道、只在很窄条件下 2 道（doc-refs 仅 3/56 发布引用带锚点；capability-gate 只对账声明且 A/B 可 0 样本 GREEN）、闸门粒度永远绿 0 道；mutants 覆盖 12/62 不参与判决、--selftest 不在 test 链上。"}
