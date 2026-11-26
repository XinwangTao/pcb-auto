# accept.ps1 · 真空通过（vacuous pass）审计

审计对象：`accept.ps1`（29,332 B / 492 行 / sha256_12=`70b5ba1579bb`，与工单一致，`Get-FileHash` 实测）
方法：逐行读 + 只读复算（`verify-artifacts.js` / `audit-design.js` / `Get-Content` / 参数化扫描 292 个 `out\*` 目录）
只读声明：未改动 `pcb-auto` 任何既有文件；未运行 `pipeline3.js / run-all.ps1 / run-overnight.ps1 / verify-drc.js / lceda-pro.exe`；未触碰 `.pipeline.lock`；未运行 `accept.ps1` 本身（它会在产物目录写 `_accept.json`，见 L470–472）。本文件是唯一新增文件。

---

## 0. 样本与分层（任何统计都先分层，不给全局百分比）

`out\` 下共 **292** 个目录（`Get-ChildItem out -Directory`）。按"有无独立闸门证据"分层：

| 层 | 判据 | n | 6/6 产物 | 备注 |
|---|---|---|---|---|
| A | 有 `_gates.independent.json` | **91** | 91/91 | 全部 `kind=pipeline` + 证据 `kind=independent-gates` |
| B | 无证据文件 | **201** | 见下 | 细分如下 |

层 B 细分（同一批 201 个目录，不跨层比较）：

| 子层 | n | 说明 |
|---|---|---|
| B1 无 `_run.json` / 0 产物 | 73 | 崩掉或非产物目录（`frames`/`gs`/`realclips` 等） |
| B2 无 `_run.json` / 3 产物 | 1 | `SHT30_Module_Full-20261125-182758` |
| B3 无 `_run.json` / 5 产物 | 2 | — |
| B4 有 `_run.json`（旧格式，无 `kind`）/ **5 产物** | **80** | 其中 **79 个 `_run.json.ok=true`** |
| B5 有 `_run.json`（旧格式）/ 6 产物 | 5 | 旧格式无证据 |
| B6 有 `_run.json`（`kind=pipeline`）/ 6 产物 | 40 | 新版但证据文件缺失（早退/被硬杀） |

判决文件层（`_accept.json`，n=211，全部 `verifyOnly=true`）：

| 键数 | allOk | n |
|---|---|---|
| 20 | false | 124 |
| 21 | false | 32 |
| 21 | **true** | **55** |

关于解析器的自校（工单要求：引用数字前先用手算过的样例验证解析器）：
- `sha256_12` 正则 `[regex]::Match($t,'sha256_12\s*=\s*([0-9a-f]{12})')`（L332）：在 `SHT30_Module_Full-20261126-060859\_pipeline_rev.txt` 上得 `f3bfb83df49a`，与该目录证据文件 `pipelineRev.sha` 手对一致；在 `AI_纯分立_9p271i-20261126-070644` 上得 `46512f7070a4`，与证据文件一致。292 个目录中 **0 例**两侧不一致。
- 魔数（L173–176）：手验 `Gerber.zip`/`BOM.xlsx`/`TestPoints.xlsx`=`504b0304`、`Board.pdf`=`25504446`、`PnP.csv`=`efbbbf44`。
- **解析器缺陷（已手纠）**：我最初用 `checks\['([^']+)'\]` 抓判据键，只得 16 个 —— 漏掉双引号的 `"产物 6/6 齐备"`（L184）、6 个插值键 `"产物 $($w.n)"`（L181）、`$checks[$drcGateKey]`（L245/246/256）。手工合并后总数 **24**。凡本报告引用"键数"处，均已按 24 修正。

---

## 1. 全部判据（24 键）· 行号 · PASS 条件 · SKIP 条件

`$checks` 是 `[ordered]@{}`（L83）。"SKIP=永不"表示该键在任何模式下都会被写入（写入值可能是 `$false`）。

### 1.1 恒定写入的 19 项

| # | 键 | 行号 | 发 PASS 的条件 | 整项消失（SKIP）的条件 |
|---|---|---|---|---|
| 1 | `_run.json 存在` | 86–91 | `Test-Path` 成立且 `Get-Content -Raw \| ConvertFrom-Json` 得非空对象（`[bool]$runMeta`） | 永不 |
| 2 | `_run.json 来自流水线(kind=pipeline)` | 96–98；else 108 | `kind` 字段存在且 `-eq 'pipeline'`；无 `kind` 走 108 恒赋 `$false` | 永不 |
| 3 | `_run.json 自述 ok=true` | 111 | `$runMeta.ok -eq $true` | 永不 |
| 4 | `自述核对·DRC 通过(gates.drcPassed)` | 123–124；else 129 | `$gates` 真值且 `drcPassed -eq $true` | 永不（else 129 赋 `$false`） |
| 5 | `自述核对·DRC 叶子为 0(gates.drcLeafCount)` | 123–125；else 130 | `drcLeafCount -eq 0` | 永不 |
| 6 | `自述核对·布线/布局 completed` | 123–126；else 131 | `routeState -eq 'completed' -and layoutState -eq 'completed'` | 永不 |
| 7 | `自述核对·6 件产物全 ok(gates)` | 123–127；else 132 | `exportsTotal -eq 6 -and exportsOk -eq 6` | 永不 |
| 8–13 | `产物 Gerber.zip` / `BOM.xlsx` / `PnP.csv` / `Netlist.json` / `TestPoints.xlsx` / `Board.pdf` | 159–166 定义，168–181 逐项写入 | `Test-Path` 且 `Length -ge min` 且（有 `magic` 且 `size≥4` 时）首 4 字节十六进制等于魔数 | 永不（`$want` 是字面量 6 项，`foreach` 必跑） |
| 14 | `产物 6/6 齐备` | 184 | `$artOk -eq 6` | 永不 |
| 15 | `独立闸门·产物校验` | 196–210 取值，214 | `$va.ran -and $va.code -eq 0` | 永不 |
| 16 | `独立闸门·产物校验(已执行)` | 215–221 | `-not ((-not $va.ran) -or ($va.code -eq 2))` | 永不（217/220 两分支都写） |
| 17 | `独立闸门·可打样(fabcheck)` | 222–224 | `$fb.ran -and $fb.code -eq 0` | 永不（222 先置 `$false`） |
| 18 | `独立闸门·设计电气审计` | 225–228；else 231 | `$designPath` 非空且 `scripts\audit-design.js` 存在，且 `$LASTEXITCODE -eq 0` | 永不（else 231 赋 `$false`） |
| 19 | `独立闸门·设计电气审计(已执行)` | 225–229；else 232 | 进入 225 分支即 `$true` | 永不 |

### 1.2 条件写入的 5 项（**可整项消失**）

| # | 键 | 行号 | 发 PASS 的条件 | 整项消失（SKIP）的条件 |
|---|---|---|---|---|
| 20 | `独立复核·DRC 复跑(verify-drc.js)` | 243–262（246 先置 `$false`） | 加了 `-RecheckDrc` 且 `verify-drc.js` exit 0 | **未加 `-RecheckDrc`**（L244 `if ($RecheckDrc)`） |
| 21 | `独立复核·DRC 有证据(-RecheckDrc 或 run-all 闸门文件)` | 383–387 | `$drcIndependent -or $evOk` | **非 `-VerifyOnly` 模式**（整块 383–401 在 `if ($VerifyOnly)` 内） |
| 22 | `独立复核·证据与产物同源(流水线版本一致)` | 391–394 | `$evRevOk -eq $true` | `-VerifyOnly` **且** `$evRevOk` 非 `$null` 才写 → **缺 `_pipeline_rev.txt`／正则不匹配／证据无 `pipelineRev.sha` 时整项消失**（L391 `if ($null -ne $evRevOk)`） |
| 23 | `独立复核·流水线退出码为 0` | 402–404 | `$pipeCode -eq 0` | **`-VerifyOnly` 模式**（else 分支 402–419） |
| 24 | `独立复核·证据文件与退出码一致` | 413–414 | `$evFinalOk -eq ($pipeCode -eq 0)` | 非 `-VerifyOnly` 且**证据文件不存在/不可解析**时（L413 `if ($null -ne $evObj)`） |

同时写入上限：`-VerifyOnly` 无 `-RecheckDrc` = 19+1+1 = **21**；`-VerifyOnly -RecheckDrc` = **22**；跑流水线模式 = 19+1(+1) = **20/21**。这就是"约 20 项"的来源。

### 1.3 有没有"必含清单/数量断言"？

**没有。** 唯一的总闸是 L422–425：

```
422: # 【显式布尔】`-contains $false` 抓不到 $null（`$null -eq $false` 为假），
423: # 于是任何"取字段值"写法的 check 一旦取到 $null 就会静默变成通过。这里要求每一项**就是 $true**。
424: $badChecks = @($checks.Keys | Where-Object { $checks[$_] -isnot [bool] -or $checks[$_] -ne $true })
425: $allOk = ($badChecks.Count -eq 0 -and $checks.Count -gt 0)
```

- L422–423 说明作者**已经诊断出同类缺陷**（`$null` 值静默变通过）并修好了**值**这一半：`$checks[$_] -isnot [bool]` 能抓 `$null`。
- 但**没修"键缺失"这一半**：`$badChecks` 从 `$checks.Keys` 出发，只遍历**已存在**的键；缺失的键永远不会进 `$badChecks`。
- `$checks.Count -gt 0` 是唯一的基数检查，**它只要 >0 就成立**（1 项也能通过）。
- 全文 grep `required|expected|Keys.Count|Count -eq` 只命中 L125、L425 两处，无白名单。

所以：**"全部项通过" 在实现上是"现有项全部为真"，不是"应有项全部存在且为真"。** 缺陷恰好落在作者修过的那半边的镜像位置。工单里"最危险"的那条，结论是：**机制成立**（且已在本仓库真实发生，见 §2.1）。

---

## 2. 逐项判定

### 2.1 SILENT-SKIP（可整项消失 ⇒ 缺失被当成通过）

**判定：存在，且在本仓库已有 124 份证据。**

键 #22（L391–394）是条件写入：

```
391:   if ($null -ne $evRevOk) {
392:     $checks['独立复核·证据与产物同源(流水线版本一致)'] = ($evRevOk -eq $true)
```

`$evRevOk` 的初值是 `$null`（L312），只在 L313–337 的块里、且 `Test-Path $revFile` 为真、且正则匹配成功、且证据有 `pipelineRev.sha` 时才会被赋值（L330–336）。任何一环不满足 → 保持 `$null` → **该项根本不写**。

实测后果（分层：按判决文件键数）：

- 211 份 `_accept.json` 中 **124 份只有 20 键**（缺 #22），55 份 21 键且 `allOk=true`，32 份 21 键且 `allOk=false`。
- 那 124 份缺键的直接原因不是"目录里没有 `_pipeline_rev.txt`"，而是 `$evObj` 为 `null`（L313 的 `if` 不进）—— 但**结果同样是该项消失，判决照常计算**。
- 在本 292 个目录里，`_gates.independent.json` 存在而 `_pipeline_rev.txt` 不存在的组合 = **0 例**，所以**至今尚未发生一次"因缺键而把 FAIL 变成 PASS"的翻转**。机制是真的，翻转还没被触发。

真实触发条件（构造，全部条件都可满足）：取 `out\SHT30_Module_Full-20261126-060859`（21 键、`allOk=true`；该目录确有 `_pipeline_rev.txt`），删掉 `_pipeline_rev.txt` 后跑 `-VerifyOnly` → `Test-Path $revFile` 为假（L330）→ `$evRevOk` 仍 `$null` → #22 不写 → 其余 20 键不变 → 仍然 `allOk=true`、exit 0，只是打印里少一行。**这就是"全部项通过"但少一项的实例。**（该目录的 `_accept.json` 已是 `allOk=true`，删除动作只会减少判据，不会新增失败项 —— `accept.ps1` 里除 #22 之外没有任何其它项引用 `_pipeline_rev.txt`，grep 已确认它只在 L327–337 被读。）

其余两个可消失项：#20（L244 `if ($RecheckDrc)` 不成立时整块不进）、#24（L413 证据文件不存在时）。#20 由用户开关决定，#24 只在跑流水线模式且证据缺失时消失 —— 该模式本来就由 `$pipeCode` 兜底（L404），不会造成翻转。

### 2.2 VACUOUS（能发 PASS 但什么都没验证）

**（a）#22 「证据与产物同源(流水线版本一致)」—— 两侧出自同一份记录，正常路径不可能失败。判定：VACUOUS。**

```
334:       $evRevOk = ($rm.Groups[1].Value -eq [string]$evObj.pipelineRev.sha)
```

- 左：`_pipeline_rev.txt` 的 `sha256_12`，由 `run-all.ps1:174` `Set-Content -Path (Join-Path $dir '_pipeline_rev.txt')` 写入。
- 右：`_gates.independent.json.pipelineRev.sha`，由 `run-all.ps1:1207` `pipelineRev = $script:PipelineRevUsed` 写入。
- 两侧同源：`Write-RevisionStamp`（`run-all.ps1:162–175`）里的 `$r = $script:PipelineRevUsed`（L164）与证据里的 `$script:PipelineRevUsed` 是**同一个内存对象**，而 `$script:PipelineRevUsed` 只在 `run-all.ps1:153–155` 赋值一次。`Write-RevisionStamp` 的调用点只有一个：`run-all.ps1:1016 Write-RevisionStamp $OutDir`，与证据文件写向同一个 `$OutDir`（L1182）。

⇒ 对任何"一次跑完"的目录，两侧必然相等，**这一项不可能失败**。它只在一种混合世代场景下有意义：上一次跑的 `_pipeline_rev.txt` 残留 + 这一次跑在 L1016 之前就退出并写了证据。也就是说它测的是"两份文件是否同一进程写"，而不是标签宣称的"证据是否为这批产物所写"。

- 标签还宣称比较了**三份**指纹。注释原文 L388–390：

  ```
  388:   # 【同源】证据里写着 pipelineRev.sha、目录里有 _pipeline_rev.txt、磁盘上有 pipeline3.js ——
  389:   # 三份指纹此前只记不判，"记录但不判定"等于没有。只在两侧都有指纹时才参与判定：
  390:   # 缺 _pipeline_rev.txt 的旧目录判为"未判定"（$null），既不冒充通过也不误杀。
  ```

  实际代码 **只比较两份**（L332–334），**从未读取磁盘上的 `scripts\pipeline3.js`**（grep `Get-FileHash`：accept.ps1 全文 0 处）。第三方指纹只出现在注释里。
- **L390 是本审计的核心证据**：作者把"缺文件"明确定义为「未判定（$null）」—— 这是**有意的设计决定**，不是疏忽。问题在于这个"未判定"状态**没有下游消费者**：L465 确实把三态导出到判决文件（`gatesEvidenceRevOk = $evRevOk`），但 L424–425 的 `$allOk` 只遍历**已存在的键**，永远看不到这个 `$null`。**"未判定"在判决层被降级成了"不存在"，而"不存在"就是通过。**
- 具体反例（真实目录 + 实时观测）：`out\SHT30_Module_Full-20261126-060859` 在 2026-11-26 07:02 被判 `allOk=true` 且 `gatesEvidenceRevOk=true`，其证据 `pipelineRev.sha=f3bfb83df49a`。我审计开始时（07:19）磁盘上的 `scripts\pipeline3.js` 已是 `46512f7070a4`（272,430 B）；审计过程中（07:25:27）负责验的循环又把它换成了 `c1f0ab2ce915`（274,492 B）。也就是说：**这个目录一直是"版本不一致"状态，而 #22 一直是 PASS** —— 因为它根本不读磁盘，无法看见磁盘变更。这不是假想场景：本仓库 91 个证据目录里，只有最后跑的那批与当前磁盘版本相同。

**（b）#24 「证据文件与退出码一致」—— 两侧同源于 `$finalOk`。判定：近似恒真（VACUOUS for well-formed evidence）。**

```
414:     $checks['独立复核·证据文件与退出码一致'] = ($evFinalOk -eq ($pipeCode -eq 0))
```
- 证据侧 `finalOk`：`run-all.ps1:1205 finalOk = ($finalOk -eq $true)`；
- 退出码侧：`run-all.ps1:1253 if ($finalOk) { exit 0 } else { exit 1 }`。
同一次运行的同一个 `$finalOk` 派生两个值，二者必然一致。它只能抓"证据是上一轮残留"这种情况（有价值，但不是标签暗示的交叉核对）。

**（c）#1 「_run.json 存在」—— `{}` 也能过。判定：局部 VACUOUS。**

```
 91: $checks['_run.json 存在'] = [bool]$runMeta
```
实测：`[bool]([pscustomobject]@{})` = `True`，`[bool]('{}' | ConvertFrom-Json)` = `True`。一个内容为 `{}` 的文件让此项 PASS。它验证的是"有个能解析的 JSON 对象"，不是"有 run 记录"。净影响被 #2 挡住（无 `kind` → L108 赋 `$false`），所以不是可独立利用的通道，但标签与语义不符。

**（d）4 项"自述核对"（#4–#7）—— 自述，但标签诚实。判定：TIGHT-as-labeled（不是真空，但无独立性）。**
`accept.ps1` 开头（L14–18）自称"验收必须独立于流水线的自述"，而这 4 项确实只是把 `_run.json.gates` 抄一遍。标签用了「自述核对」四字（L124–127），与 L288–286 的注释一致，属于诚实标注。**唯一缺陷是类型不严**：`-eq` 会做跨类型强制（实测 `'true' -eq $true`=True、`'0' -eq 0`=True、`'6' -eq 6`=True、`1 -eq $true`=True），而本文件在 L294–298 明文要求"同一个判决文件不能有两套标准"，对证据文件用了 `-is [bool]`，对 `_run.json.gates` 却没用。一条 `"drcPassed": "true"` 的 `_run.json` 能让 #4 PASS —— 这不是 DRC 证据，是一个字符串。

### 2.3 TIGHT（有真证据才能过）

- **#8–#13 + #14 六件产物**：文件系统事实（存在 + 字节数 + 4/6 项有魔数）。真空通过不可能，但**地板很低**：见 §3.6。这是全脚本真正的承重墙 —— 层 B4 有 **79 个目录 `_run.json.ok=true` 而只缺 `TestPoints.xlsx`**，靠的就是这 6 项把"自述通过"钉死为 FAIL。
- **#2 kind**：无 `kind` 时 else 分支（L108）显式赋 `$false`，fail-closed，写法正确。
- **#15 产物校验**：要求 `verify-artifacts.js` exit 0。实测该脚本 exit 0 需要 `fails.length===0`（`verify-artifacts.js:598`），且它在缺 `Netlist.json` 时抛错走 `catch`→exit 2（L601–604，实测 `SHT30_Module_Full-20261125-182758` → `校验器异常: 缺 Netlist.json`，exit 2）。**注意**：`-Design` 指向目录内 `_design.snapshot.json` 时（211 份判决中 23 份如此），它比较的是"建板用的那份设计"与"导出网表"，仍然检验导出保真，但不检验"设计本身对不对"（后者靠 #18）。
- **#17 fabcheck**：#224 要求 `exit 0`；`fabcheck.js:930 process.exitCode = main()`，`main` 在缺 `Netlist.json` 等情况下返回 `res.exit`（1）或 2（L917–919），只有 `check()` 判"可打样"才 0。
- **#23 流水线退出码**：`run-all.ps1:1253 if ($finalOk) { exit 0 }` 是**独立测量**，且 `run-all.ps1:1162–1166` 的终判含 `verifyOk/drcReOk/fabReOk/fmtBad/docsOk`。这是跑流水线模式下唯一的硬证据。**但本仓库 211 份判决全部 `verifyOnly=true`，该分支从未被样本覆盖**（见 §6）。
- **#21 DRC 有证据**：`($drcIndependent -or $evOk)`，其中 `$evOk`（L298–304）要求 `finalOk`、`gates.drcIndependent`、`gates.fabcheck`、`gates.artifactsFormat` **都是真布尔且为真**（`-is [bool]` 守卫，L298–302）。类型上比 #4–#7 严，写法正确。
- **#20 RecheckDrc**：`$checks[$drcGateKey] = $false` 先落（L246），任何异常路径都不会变成 `$true`（fail-closed 写法正确）；`verify-drc.js:216 process.exit(v.passed === true ? 0 : (v.consistent === false ? 2 : 1))`，且 `consistent = passed ? (itemsErr === null && total === 0) : true`（L117），exit 0 是真测量。
- **#18 设计电气审计**：`audit-design.js:439 process.exit((totalFails === 0 && skipped === 0) ? 0 : 1)`，"跳过≠通过"已修（L355–380）。**残留**：`audit()`（L29–37）对 `components: []` 返回 0 fails，`{"components":[]}` 这种合法空设计会 exit 0 → #18 PASS 而一个器件都没审。accept.ps1 侧（L225）没有"设计非空"的前置条件。实际不可利用（#15 会拿 0 器件对真网表而 FAIL），但这是一条真空支路。
  另：该闸门的输出在 L227 被 `| Out-Null` 丢弃，而失败时 L436–446 的"失败闸门原始输出"只摊开 `$va` 与 `$fb`（L439 的 `@(@('产物校验', $va), @('可打样', $fb))`），**审计失败时控制台没有任何电路错误明细** —— 只有一行 `[FAIL] 独立闸门·设计电气审计`。不影响判定，影响可诊断性。
- **#16 / #19 「(已执行)」**：仅记录"有没有跑"，PASS 条件不含结果，属于诚实的状态位。**#16 有一处归因错误**，见 §5 P1-1。

---

## 3. 七种危险形状核对（逐条回答"是否存在"）

### 3.1 `if ($x)` / `if (Test-Path ...)` 而 else 分支什么都不加 —— **存在（1 处真危险）**
- **L330–336**：`if (Test-Path $revFile) { ... }`，**无 else** → 缺文件时 `$evRevOk` 保持 `$null` → #22 消失（不是 `$false`）。危险。
- **L313**：`if ($null -ne $evObj -and $OutDir -and (Test-Path $OutDir))`，无 else → `$evFresh=false`、`$evRevOk=null`。`$evFresh` 的默认值是安全的（L311 `$evFresh = $false`），`$evRevOk` 的默认值不安全（L312 `= $null`）。危险。
- **L413**：`if ($null -ne $evObj)`，无 else → #24 消失。低危（有 `$pipeCode` 兜底）。
- **L88–90**：`if (Test-Path $runFile) { try{...} }`，无 else，但 `$runMeta` 初值 `$null`（L87）→ #1 得 `$false`，安全。
- **L123–134**：有 else 且 else 显式置 4 个 `$false` —— **正确写法，可作模板**。
- **L144–155**：`if ($null -ne $gates)`，无 else，只影响 `$observed`（不进 `$checks`），无判据影响。
- **L445**：`if ($runMeta -and $runMeta.PSObject.Properties['errors']) { }` —— **空块死代码**，什么都不做。

### 3.2 空集合判定在 0 元素上为真（`@(...).Count -eq 0`）—— **存在（就是判决总闸）**
L424 `$badChecks.Count -eq 0` 正是这个形状：`$checks` 为空/缺项时 `$badChecks` 也为空 → 判定为"没有坏项"。唯一的缓解是 L425 的 `$checks.Count -gt 0`，它只防"全空"，不防"少几项"。**这就是 §1.3 的结论。**

### 3.3 拿同一份记录自我印证（self-reference）—— **存在（#22、#24）**
- #22 的两侧都由 `run-all.ps1:153–155` 的 `$script:PipelineRevUsed` 派生（写点：`run-all.ps1:168` 与 `:1207`）。见 §2.2(a)。
- #24 的两侧都由 `run-all.ps1` 的 `$finalOk` 派生（`:1205` 与 `:1253`）。见 §2.2(b)。
- 另有"隔一层"的自指：`-Design` 指向目录内 `_design.snapshot.json` 时（23/211 份判决如此），#15 比较的是"建板用设计"与"导出网表"。这不是恒真（导出环节可损坏），但不构成对设计意图的独立检验。

### 3.4 对 `_pipeline_rev.txt` 的检查在文件缺失时 fail-open —— **存在（L330 + L391）**
见 §2.1。这是本审计里"最该修"的一条：缺文件不是"未判定"，系统把它当"没有这一项"。

### 3.5 "版本一致"检查的两侧出自同一份记录 —— **存在（#22）**
见 §2.2(a)。且注释 L388 宣称的第三方（磁盘 `pipeline3.js`）在代码里不存在。

### 3.6 glob / 模式匹配在零命中时通过 —— **不存在（accept.ps1 无任何 glob）**
`grep 'Get-ChildItem|Get-Item|\*\.|Filter|-like'` 只命中 L171、L322 两处**单文件** `Get-Item`；`$want`（L159–166）是 6 个字面量。**没有"枚举为空即通过"的形状。**
但存在**正则版的同形缺陷**：L332 的 `[regex]::Match` 不命中时不判失败，而是让 L333 的 `if` 不成立 → #22 消失（§3.4），而不是 #22 FAIL。

### 3.7 容差带宽到能接受错误答案 —— **存在（尺寸地板）**
阈值（L160–165）与 A 层 91 个目录的**实测**尺寸（分层 A，不含旧格式）：

| 产物 | 代码地板 min | A 层实测 min | 实测 median | 倍数 |
|---|---|---|---|---|
| Gerber.zip | 2,000 | 18,199 | 36,093 | 9.1× |
| BOM.xlsx | 2,000 | 6,933 | 7,335 | 3.5× |
| PnP.csv | **100** | 633 | 1,969 | 6.3× |
| Netlist.json | **200** | 8,647 | 29,756 | **43.2×** |
| TestPoints.xlsx | 500 | 8,089 | 8,167 | 16.2× |
| Board.pdf | 2,000 | 316,203 | 428,066 | 158× |

`PnP.csv` 与 `Netlist.json` **没有魔数**（L162–163 无 `magic` 键，L173 的分支不执行），所以一个 100 B 的 `PnP.csv`、一个 200 B 的"合法但近乎空的" `Netlist.json` 都能让 #9/#11 PASS。二次拦截只在 `$designPath` 存在时由 #15 提供（截断的 JSON 会让 `verify-artifacts.js` 抛错 → exit 2 → **被记成"未执行"**，见 §5 P1-1，归因也错了）。
另一处宽带宽：`$evFresh = ($evTime -ge $newest)`（L326）**没有上界** —— 一份三年前的证据文件，只要比交付物新就算"新鲜"。

---

## 4. 最关键的问题：空目录 / 截断目录能否 exit 0？

**答案：不能。而且不是"大概不能"，是被两道互相独立的锁分别挡住。**

### 4.1 实际控制流（以 `-VerifyOnly -OutDir <空目录>` 为例，逐行）

```
L88  Test-Path $runFile        -> False   => $runMeta = $null
L91  [bool]$null               -> #1  = $false
L96  $hasKind = $false         -> L108     #2  = $false
L111 $runMeta -and ...         -> #3  = $false
L122 $gates = $null            -> L129-132 #4-#7 = $false（else 分支显式赋 false）
L168 foreach 6 项: Test-Path 全 False -> $size=0 -> $ok=$false -> #8-#13 = $false
L184 $artOk = 0                -> #14 = $false
L190 脚本存在 -> L192 & node <OutDir> -> verify-artifacts.js:214 throw -> catch 601 -> exit 2
L214 $va.code=2                -> #15 = $false
L215 prodGateNotRun = true     -> L217     #16 = $false
L223 fabcheck <空目录>          -> 非 0（缺 BOM/Gerber 等）  -> #17 = $false
L225 $designPath=$null         -> L231-232 #18/#19 = $false
L387 $drcIndependent=$false, $evOk=$false -> #21 = $false
L391 $evRevOk=$null            -> #22 不写（少一项，但不影响下面的判定）
L424 badChecks.Count ≥ 14      -> $allOk=$false -> L491 exit 1
```

**至少 14 项为 `$false`。** 其中 #8–#13 与 #14 在 L168–184 **无条件**执行、无 `return`/`exit` 可跳过；#1–#7 在 L91–132 无条件写入。L424 的 `-isnot [bool] -or -ne $true` 会把任何一个 `$false` 变成非零退出。

**结论不依赖 fabcheck 的具体返回码**（fabcheck 我没跑，见 §6）：即使 #17 变 `$true`，仍有 ≥13 项为 `$false`。

### 4.2 三条逃逸路线都被自己的锁堵住

1. **只有 `_run.json`**：`$runMeta` 成立 → #1/#3 PASS，但 #8–#14 全 FAIL（6 件产物是字面量清单，不是目录枚举）。
2. **`-VerifyOnly` + `-RecheckDrc` 想绕过证据**：`verify-drc.js` 需要 `$runMeta.projectUuid`（L248）；空目录的 `_run.json` 没有该字段 → L246 的 `$false` 保持 → #20 FAIL，fail-closed 正确。
3. **`-RecheckDrc` 但没有证据文件、想靠 `$drcIndependent` 过 #21**：`$checks['独立复核·DRC 有证据'] = ($drcIndependent -or $evOk)`（L387）—— 这一条只在 `-RecheckDrc` 真跑通（exit 0）时才成立，而 `verify-drc.js` 的 exit 0 要求 `passed && total===0 && itemsErr===null`（L117/L216），不是"空即通过"。

### 4.3 真正的残余风险（不是"空目录"，是"少一项"）

- 空/截断目录被挡住，是因为**那 19 项恰好都写成了无条件**。脚本里**没有任何机制**保证这一点：谁把 #8–#14 挪进某个 `if`，L424–425 会立刻把"缺项"读成"通过"。
- 已经发生的实证：**124/211 份判决文件里 #22 整项不存在**（§2.1）。今天它不影响退出码，只因为 #22 是恒真的装饰项；一旦它被修成有判别力的判据（比如真的去比磁盘上的 `pipeline3.js`），这 124 份就会静默变成"少一项 → 仍 exit 0"。

---

## 5. 补丁（**未应用**；P0 = 会让更多东西 FAIL 的真修复，P1 = 修错误归因/假失败）

### P0-1 判决总闸加"必含清单"（关掉所有 SILENT-SKIP）

`accept.ps1:424–425`

old：
```
$badChecks = @($checks.Keys | Where-Object { $checks[$_] -isnot [bool] -or $checks[$_] -ne $true })
$allOk = ($badChecks.Count -eq 0 -and $checks.Count -gt 0)
```
new：
```
$requiredKeys = @('_run.json 存在','_run.json 来自流水线(kind=pipeline)','_run.json 自述 ok=true','自述核对·DRC 通过(gates.drcPassed)','自述核对·DRC 叶子为 0(gates.drcLeafCount)','自述核对·布线/布局 completed','自述核对·6 件产物全 ok(gates)','产物 Gerber.zip','产物 BOM.xlsx','产物 PnP.csv','产物 Netlist.json','产物 TestPoints.xlsx','产物 Board.pdf','产物 6/6 齐备','独立闸门·产物校验','独立闸门·产物校验(已执行)','独立闸门·可打样(fabcheck)','独立闸门·设计电气审计','独立闸门·设计电气审计(已执行)')
if ($VerifyOnly) { $requiredKeys += @('独立复核·DRC 有证据(-RecheckDrc 或 run-all 闸门文件)','独立复核·证据与产物同源(已判定)') } else { $requiredKeys += @('独立复核·流水线退出码为 0') }
$missingKeys = @($requiredKeys | Where-Object { -not $checks.Contains($_) })
if ($missingKeys.Count -gt 0) { Write-Host ("  ! 判据缺失（不当作通过）：{0}" -f ($missingKeys -join ' / ')) -ForegroundColor Red }
$badChecks = @($checks.Keys | Where-Object { $checks[$_] -isnot [bool] -or $checks[$_] -ne $true })
$allOk = ($badChecks.Count -eq 0 -and $missingKeys.Count -eq 0 -and $checks.Count -gt 0)
```
（`$checks.Contains()` 在 `[ordered]@{}` 上可用，实测缺键返回 `False`。此补丁依赖 P0-2 先落 `…(已判定)` 键，否则 `-VerifyOnly` 会恒缺一项。）

### P0-2 `_pipeline_rev.txt` 缺失改为 fail-closed（不再整项消失）

`accept.ps1:391–394`

old：
```
  if ($null -ne $evRevOk) {
    $checks['独立复核·证据与产物同源(流水线版本一致)'] = ($evRevOk -eq $true)
    if (-not $evRevOk) { Write-Host '  ! 证据文件记录的 pipeline3 版本与目录里产物的版本不一致：这份证据不是为这批产物写的。' -ForegroundColor Red }
  }
```
new：
```
  $checks['独立复核·证据与产物同源(已判定)'] = ($null -ne $evRevOk)
  $checks['独立复核·证据与产物同源(流水线版本一致)'] = ($evRevOk -eq $true)
  if (-not $evRevOk) { Write-Host '  ! 证据与 _pipeline_rev.txt 的 pipeline3 版本不一致或缺失：不能证明这份证据属于这批产物。' -ForegroundColor Red }
```
行为变化：缺 `_pipeline_rev.txt` / 正则不命中 / 证据无 `pipelineRev.sha` 时，由"少两项"变成"两项 FAIL"。

### P0-3 尺寸地板抬到实测下限之下（仍留余量，但不再是 43 倍带宽）

`accept.ps1:162–163`

old：
```
  @{ n = 'PnP.csv'; min = 100 },
  @{ n = 'Netlist.json'; min = 200 },
```
new：
```
  @{ n = 'PnP.csv'; min = 400 },
  @{ n = 'Netlist.json'; min = 4000 },
```
（依据：分层 A 的 91 个目录实测 min 为 633 / 8,647。**更好的修法是解析**：`Netlist.json` 加 `ConvertFrom-Json` + `components` 非空断言，`PnP.csv` 加表头行断言 —— 那需要新增代码块，不是最小补丁。）

### P0-4（可选，语义修复）把 #22 降级为"记录项"

若认定 #22 无判别力（§2.2a），最小改法是把 L392 的写入目标从 `$checks` 换成 `$observed`，并从 P0-1 的 `$requiredKeys` 里去掉 `…(已判定)`。**二者择一，不要同时做。**

### P1-1 `verify-artifacts.js` exit 2 的归因错误（截断目录被写成"没核对"）

`accept.ps1:215`

old：
```
$prodGateNotRun = (-not $va.ran) -or ($va.code -eq 2)
```
new：
```
$prodGateNotRun = (-not $va.ran) -or ($va.code -eq 2 -and -not $designPath)
```
证据：`verify-artifacts.js` 的 exit 2 有两条完全不同的来源 —— 缺 design 参数（`:214 throw`）**与**校验器异常（`:601 catch`）。实测 `out\SHT30_Module_Full-20261125-182758`（无 `Netlist.json`）配真实设计 → `校验器异常: 缺 Netlist.json`，**exit 2**。当前代码会把"产物残缺"记成"未执行（缺 design 路径或脚本缺失）"（L218 的措辞），`_accept.json.prodGateExecuted` 也随之写错。修后：`#15=false`（不变）+ `#16=true`，归因正确。

### P1-2 `_run.json` 自述字段补真布尔守卫（与 L294–298 自定的标准一致）

`accept.ps1:111`（同理 124 / 125 / 127）

old：`$checks['_run.json 自述 ok=true'] = ($runMeta -and $runMeta.ok -eq $true)`
new：`$checks['_run.json 自述 ok=true'] = ($runMeta -and $runMeta.ok -is [bool] -and $runMeta.ok -eq $true)`

old：`  $checks['自述核对·DRC 通过(gates.drcPassed)'] = ($gates.drcPassed -eq $true)`
new：`  $checks['自述核对·DRC 通过(gates.drcPassed)'] = ($gates.drcPassed -is [bool] -and $gates.drcPassed -eq $true)`

old：`  $checks['自述核对·DRC 叶子为 0(gates.drcLeafCount)'] = ($gates.drcLeafCount -eq 0)`
new：`  $checks['自述核对·DRC 叶子为 0(gates.drcLeafCount)'] = ($gates.drcLeafCount -is [long] -and $gates.drcLeafCount -eq 0)`

old：`  $checks['自述核对·6 件产物全 ok(gates)'] = (($gates.exportsTotal -eq 6) -and ($gates.exportsOk -eq 6))`
new：`  $checks['自述核对·6 件产物全 ok(gates)'] = (($gates.exportsTotal -is [long]) -and ($gates.exportsTotal -eq 6) -and ($gates.exportsOk -is [long]) -and ($gates.exportsOk -eq 6))`
（本机 PS7 `ConvertFrom-Json` 的整数一律 `Int64`，实测 `0`/`6` 均 `-is [long]`=True；`'true' -eq $true`=True、`'0' -eq 0`=True、`'6' -eq 6`=True 已实测 —— 不加守卫时字符串/整数都能冒充布尔证据。注意**不要**用 `-is [ValueType]`：`$false -eq 0` 为 True。）

### 非补丁类说明

- `L209`/`L223` 的 `-Label '产物校验'` / `-Label '可打样'`：`Invoke-Gate`（L187–194）没有 `Label` 参数，但它是**非 advanced 函数**，未知名参数会落进 `$args` 而不报错（实测：`ExtraArgs=D:\x\y.json args=-Label|产物校验`）。所以不崩、也不生效，是死参数。**删不删都不影响判决**，但它会误导读者以为标签被用上了。
- `L287` 的 `else { $null }` 分支不可达（L44/L47 保证 `$OutDir` 非空）；L445 是空块死代码。

---

## 6. 我**没能**验证的（以及原因）

1. **跑流水线分支（L402–419）从未被样本覆盖**：本仓库 211 份 `_accept.json` 全部 `verifyOnly=true`、`pipelineExit=-1`。我对 #23/#24 的判断是**静态读码**（`run-all.ps1:1205/1253` 同源），没有一次真实 `accept.ps1 -Idea …` 的运行证据。原因是工单禁止运行 `run-all.ps1`／`pipeline3.js`／`verify-drc.js`，且此刻有循环持锁。
2. **没有运行 `fabcheck.js`**（不在允许清单里，且 `-VerifyOnly` 路径会调它）。§4.1 里 #17 的 `$false` 是**推断**；但 §4.1 的结论不依赖它（已有 ≥13 项 `$false`）。
3. **没有运行 `accept.ps1` 本身**：它会在目标目录写 `_accept.json`（L470–472），与"只新增一个文件"冲突。所有"PASS/FAIL 会怎么打印"的结论都由读码 + 就地复算谓词得出，未做端到端执行。
4. **`-RecheckDrc` 的端到端行为未测**：`verify-drc.js` 会自拉 lceda-pro 会话（工单明令禁止）。#20 的判定只基于其 `process.exit` 语义（`verify-drc.js:117/216`）与 run-all 的注释（`run-all.ps1:744–749`、`804–806`）。
5. **`_gates.independent.json` 是否可能被伪造**：这是信任边界问题，非脚本缺陷，未测。任何能写产物目录的人都能手写一份全绿证据，`$evKindOk`/`$evFresh`（L310–326）只能挡"陈旧"，不能挡"伪造"。
6. **并发写入下的读数一致性**：`out\AI_OLED_底板_5p5g6m-20261126-071309` 在我审计期间正被运行中的循环写入（mtime 7:20:01），`scripts\pipeline3.js` 也在 07:19→07:25 之间从 `46512f7070a4` 变成 `c1f0ab2ce915`。我没有对那个目录做任何判定；§0 的统计里它计入层 B（当时无证据文件），这个分层结论**可能随那轮跑完而改变**。同理，§2.2(a) 里"磁盘版本"的值是**瞬间快照**，几分钟后就过期 —— 这本身就是该发现的证据：任何不读磁盘的"同源"检查都无法追踪一个每轮都在变的文件。
7. **`$evFresh` 在时钟回拨/跨时区场景的行为**：`generatedAt` 带 `+08:00`，`-as [datetime]` 得 `Kind=Local`（实测），与文件 mtime 同为本地时间，比较成立；但没有跨时区样本。

---

## 7. 一句话结论

`accept.ps1` 的**承重墙是真的**（6 件产物的文件系统事实 + `verify-artifacts`/`fabcheck`/`audit-design` 的退出码 + `verify-drc` 证据），所以**空目录、截断目录、`_run.json` 自述 ok=true 但产物不全的 79 个真实目录，今天都到不了 exit 0**。真空风险集中在**"独立复核"这一层的 5 个条件项**：其中 `证据与产物同源`（L391–394）是**同源恒真 + 缺文件即消失**的双重装饰项，`证据与退出码一致`（L414）是同源恒真，而 `$allOk`（L424–425）**没有必含清单** —— 于是"全部项通过"在实现上是"剩下那些项都为真"。这是结构性缺陷，不是当前就能触发的漏洞。

STATUS={"status":"ok","changed":["out/_probe/_vac-audit.md"],"verify":{"cmd":"node scripts/verify-artifacts.js out/AI_纯分立_9p271i-20261126-070644 out/AI_纯分立_9p271i-20261126-070644/_design.snapshot.json","exit":0},"reason":"24 keys catalogued with line numbers; no required-list exists (only checks.Count -gt 0 at L425); #22 self-reference tautology (run-all.ps1:153-155 -> :168 and :1207) + silent-skip (124/211 verdicts lack it); empty/truncated dir cannot reach exit 0 (>=14 unconditionally-added checks false, verified by static control flow + empirical exit codes 2/0); 6 patches given, none applied"}
