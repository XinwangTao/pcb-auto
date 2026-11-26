# 已知缺陷与自查记录

<!-- ANCHOR-BASE: scripts/pipeline3.js sha256_12=E433D662DA70。
     本文所有 pipeline3.js 行号都相对于这一份源码。行号漂移量不是常数
     （实测 stitchErr +497、patchNoGeo +582），所以发现哈希变了必须逐个按内容重锚，
     不能加偏移。test/doc-refs.mjs 只验「被指到的行非空」，不验「指对了」。 -->

这份文档记录本项目自己审计出来的缺陷，也记录审计过程中**被证伪**的说法。一个声称「可信」的流水线，如果只公布通过率，读的人分不清它是真测过，还是只挑了好样本。把错的也写出来，别人才有得核对。

每条都标了核实状态：**真**（结论与代码、语料一致）、**部分真**（成立的那一半与不成立的那一半分开写）、**假**（当初的怀疑不成立）。每条给出代码位置（`文件:行号`）、在 `out\` 语料里观测到的数字，以及一句自己能重跑的核对命令。

**以下结论均为 2026-11-26 对仓库内代码与 `out\` 语料的核对结果，语料会变，所以每条都给了自己能重跑的定位信息。**

## 结论速览

| 编号 | 结论 | 一句话 | 位置 |
|---|---|---|---|
| 1 | 部分真 | `skippedNoAnchor` 字段真实存在且语料全 0，但其中一条自增分支静态不可达 | `scripts/pipeline3.js:2248,2343,2354,2392` |
| 2 | 真 | 补线阶段 5 处丢弃点，只有一处连日志都没有；真正大量丢的是 80mil 上限那条 | `scripts/pipeline3.js:4495,4505-4507,4538-4542,4615-4619,4621-4623,4659-4662` |
| 3 | 真 | 缝合失败只记一句异常字符串，37 次全是同一句，不带网/坐标/id | `scripts/pipeline3.js:2359-2388` |
| 4 | 真 | `fixed` 数的是「变更 API 接受了」，不是「违规真的减少了」 | `scripts/pipeline3.js:4215,4226-4228` |
| 5 | 部分真 | 逐级收窄是真的；但它不是「白名单」，白名单这个词在代码里不存在 | `scripts/pipeline3.js:4375,4507,4539,4554,4622` |
| 6 | 假 | 负 Y / 某个负坐标不是坐标系符号错；那条坐标是测试夹具字面 | `scripts/pipeline3.js:729-733` |
| 7 | 真 | `coverage` 算完只进日志，此后无人读取，「过孔盘覆盖不足」假设没接过任何动作 | `scripts/pipeline3.js:4604,4606-4613,4615-4618` |
| 8 | 真 | `rulesApplied` 只有一处赋值、不进 `_run.json`、不参与判定；136 次里 30 次为 false | `scripts/pipeline3.js:1902`（`rulesApplied` 全文仅出现在这段注释里，无任何读取/赋值） |
| 9 | 假 | Slot Region 有 5 条独立处理路径；没有认领者的是另外两类违规 | `scripts/pipeline3.js` 的 `slotKeepout` / `slotPadGeometry` / `ensureGeoIdx` / `slotHoleUsed` / `noSideIsViaOrTrack` |
| 10 | 真 | `_run.json` 写的是布局前的声明板框，扩板后从不回写 | `scripts/pipeline3.js:704-715,885-897,5225,5303`；`scripts/fabcheck.js:445-448` |
| 11 | 部分真 | 重试阶梯里确实有预缩机制；但语料里 0 次收缩转移，收缩只发生在第一轮之前 | `run-all.ps1:558-571 "$estArea = [Math]::Max(480000, $compCount * 55000 + $connCount * 9000)"` |
| 12 | 真 | 流水线不查图元绝对坐标出框，真正的判定在离线校验器里 | `scripts/pipeline3.js:836-901`（只查焊盘 bbox 与 `PAD_OFFBOARD_TOL`，不查图元绝对坐标）；`scripts/fabcheck.js:415,463-468` |
| 13 | 真 | README 生成脚本用动态值算目录数，却把「两目录」写死在散文里 | `out/_probe/sync-readme-numbers.py:153-156`；`交付-README.md:44-45` |
| 14 | 真 | `fabcheck` 四类结果都以 `id` 为第一键同台输出，正则数 `"id"` 会把阻断数放大 | `scripts/fabcheck.js:312-319,764-771,781-784` |
| 15 | 真 | `_run.json.ok` 与「可下单」不是同一批：48 相等是巧合，集合不同 | `out/_probe/fab-census.json`；`scripts/fabcheck.js:764-771` |
| 16 | 真 | 布线变体 7 份配置里有 5 份从来没被执行过（129/143 个目录只出现 `variants[0]`） | `scripts/pipeline3.js:1573,1647,1711-1716,1756` |
| 17 | 真 | 布线阶梯按「作业自报 state」判去留，7 份各烧满 120s 换来零走线，导出 0/6 全部 `budget` | `scripts/pipeline3.js:1647-1660,1677-1696,1711-1716` |
| 18 | 真 | `outlineFit` 只比焊盘 bbox 尺寸不比位置：实测 122 mil 焊盘挂在板外，却报成「超 48 mil」 | `scripts/pipeline3.js:854-860,867-880,893-901` |
| 19 | 真 | 天线净空带 240 mil 高、压住模组自己焊盘，`NO_WIRES` 封死出线（DRC 里 7 条 Prohibited Region） | `scripts/pipeline3.js:973-975,1031-1035,1053-1062,1076-1082` |
| 20 | 真 | 同网表 1000 mil 布不通、1300 mil 布得通：7 份配置 0 条 vs 602 条，限制因素是板宽 | `designs/mic-esp32s3-v2.json`；`designs/mic-esp32s3-v3.json` |
| 21 | 真 | `run-all.ps1` 用 `2>&1 \| Out-String` 把 stderr 并进 JSON，一次 6/6 产物齐全的构建被判成 `NON_JSON 未知输出` 并整轮重跑 | `run-all.ps1` 的四处 invoke 捕获点 |
| 22 | 真 | 强轮上限 6 比 4 差：多两轮约 280s、DRC 收益 0，还把断连从 6 推到 105 | `scripts/pipeline3.js:1633-1635`（`MAX_ROUTE_ITERS`）、`scripts/pipeline3.js:1825-1831`（`routeIter` 落盘） |
| 28 | 真 | 整轮净空回滚删掉 GND 缝合孔后没补回来，`clearanceRevertOk` 仍报 true：实测 4 个地孔换来 4 条新断连 | `scripts/pipeline3.js:3223-3236,3268-3338,3355-3390` |
| 23 | 真 | `patchDrc` 两轮两败（33→56、62→84，均整轮撤回），`patchTotal` 恒 0 | `scripts/pipeline3.js` 的 `patchVerify` / `patchReverted` |
| 24 | 真 | `doc-refs` 只判被引用那一行非空，不判内容还对不对 —— 插 70 行后它继续亮绿灯 | `test/doc-refs.mjs` |
| 25 | 真 | 遥测改名只在成功路径上，失败那一轮的 `_run.json` / `_log.json` 被下一轮直接覆盖 | `run-all.ps1` 的 `_run-<idx>-<tag>` 改名块 |
| 26 | 真 | 器件坐标被 `_placement` 钉死时，扩板重试是可证明的 no-op：面积 +56%，DRC 直方图逐位相同 | `designs/mic-esp32s3-v3.json` 的 `_placement`；`scripts/pipeline3.js` 的 `outlineFit.explicitFixed` |
| 27 | 真 | `ensureGeoIdx` 漏了 pour / poured：`resolveByOwner` 里那个 `owner === 'pour'` 分支永远不可达 | `scripts/pipeline3.js` 的 `ensureGeoIdx` / `resolveByOwner` |
| 29 | 真 | `clearanceReverted` 的字段名不含分母：`deleted`/`restored` 只数**走线**，`viaRestored` 只数**过孔** —— 实测 `{deleted:4, restored:2, viaRestored:2}` 与同份日志里`viaDeleted` ×4 并排出现，两个 4 指向完全不同的对象，读成「删 4 个孔只补回 2 个」（我本人就这么误判了一轮），而 `deleted` 数的 4 条是走线、跟孔无关 | `scripts/pipeline3.js:3223-3228,3241,3350,3355` |
| 30 | 真 | `preVia` 的「被包围 GND 焊盘」判据 `(hasUp&&hasDown)||(hasLeft&&hasRight)` 只问有没有邻居、不问焊盘多大：0.5mm 间距引脚（盘心 19.7 mil）天然左右都有邻居，于是在实测 10×24 mil 的焊盘上打了 19.7 mil 外径的孔，造出 4 条 `SMD Pad to Via cur=0` 硬短路 | `scripts/pipeline3.js` 的 preVia（按事件名 `epViaSkip` / `EP_VIA_NEED` 定位）；闸门 `test/epvia-size-gate.mjs` |

**统计口径。** 30 条：**25 真 / 3 部分真 / 2 假 / 0 未证实**。第 21-25 条测于 2026-11-26（ISO 8601 见各条正文），分母都是**当次单次运行**，不是整个 `out\` 语料 —— 因此它们不受清理窗口影响；凡引用语料级数字的地方（第 9、16、17 条）时点与分母写在正文或 `out\_probe\fab-census.json` 的 `measured_at`。

语料规模：`out\` 下 **56 个含 `_run.json` 的目录**，其中 **53 个可下单**、3 个有阻断、0 个解析失败。来源是快照 `out\_probe\fab-census.json`，**测于该文件的 `measured_at` 字段**（引用时直接读它，不要读 mtime —— 理由见下一段。这里故意不写「第 N 行」：那种引用会在任何一次插入后指错地方）。

**为什么不能拿 mtime 当时点。** mtime 是文件系统的属性，不是测量的属性：任何人 `git clone` 之后，仓库里每个文件的 mtime 都等于**克隆时刻**。所以「测于 `<文件>` 的 mtime」这句话对**每一个读者**都是错的，而他没有任何办法从仓库里看出真实时点。时点放进了 JSON 的 `measured_at` 字段，字段跟着 blob 走，克隆、拷贝、checkout 都不会改它。

这些数字有时点。`out\` 会被清理脚本按「保留最新 40 个目录 + 每个设计名最新 1 份」滚动裁剪（`scripts/cleanup.ps1:19`），所以任何「N 个目录里 M 个…」都会随时间和清理动作变化；引用时必须带时点与分母，否则下次复算对不上。

## 一、已证实的缺陷（真）

### 2. 补线阶段的丢弃路径：只有一处连日志都没有

**现象。** 兜底补线循环（`for (const v of connErrs)`，`4467` 起、`4647` 收）里一共 **7 处 `continue`**。每一处都意味着「这条断连本轮不再往下走」。注意：其中一部分是**已经动过板**才收尾的（`3814` 跨层分支真的打了过孔），另一部分是真的什么都没做。

**代码位置。** 典型的那一处 `scripts/pipeline3.js:4505-4507`：

```js
const edPos = ed.position;
const pos = edPos ? { x: Number(edPos.x) * 10, y: Number(edPos.y) * 10 } : v.pos;
if (!net || !pos) { log('patchNoNet', { err: String(ed.globalIndex || ''), obj1: String(ed.obj1 || '') }); continue; }
```

**全部 7 处丢弃点。** 语料：`out\*\_log*.json` 共 **136** 个文件（分母）。

| 行 | 条件 | 日志名 | 语料次数 |
|---|---|---|---|
| `pipeline3.js:4507` | 拿不到网名或位置 | `patchNoNet` | **0** |
| `pipeline3.js:4539` | 两个图元查不到几何 | `patchNoGeo` | **0** |
| `pipeline3.js:4545` | `closestPair` 返回空或距离非有限 | **没有日志** | **无法计数** |
| `pipeline3.js:4583,4590` | 跨层分支收尾（打孔成功记 `patchedCrossLayer`、失败记 `patchCrossLayerNoObj`） | 两条都有 | **0 / 0** |
| `pipeline3.js:4615` | 两对象已贴合仍不连通（跨层时先试过打孔） | `patchIslandPair` | **1** |
| `pipeline3.js:4622` | `cp.d > 80`（80mil 上限） | `patchTooFar` | **653** |
| `pipeline3.js:4661` | `create` 之后一个 id 都没拿到（已回滚） | `patchNoObj` | **0** |

**真正的问题在哪一行。** 不是最容易被注意到的 L4311，而是 **L4349**：

```js
const cp = closestPair(o1, o2);
if (!cp || !Number.isFinite(cp.d)) continue;   // ← 没有 log，没有计数，没有痕迹
```

其余 **6** 处都会留一条具名日志，所以能被数出来 —— 六项加起来正好 **654** 次（`0 + 0 + 0 + 0 + 1 + 653 + 0`）。L3764 不留任何东西 —— 它触发了多少次，**现有语料里查不出来**，而且以后也不会查得出来。这跟 `census` 在没产物时报出「56 个目录」是同一类错误：度量失败时保持沉默，读者看到的是一个看起来正常的数字。

**影响。** 「补线阶段会静默丢弃断连」成立，但主因不是丢弃本身：653 次丢弃里 653 次都是「两图元相距超过 80mil」，这是几何上真的接不上，丢弃是**正确**行为，而且它被记了数。把这条写成「补线失败的主因」会指错地方；真正该补的是 L3764 缺一条日志。

**怎么自己核对。**

```bash
# 7 处 continue 的位置（其中一行是唯一没有日志的）
grep -n 'continue;' scripts/pipeline3.js | sed -n '/37[0-9][0-9]:/p;/38[0-9][0-9]:/p'
grep -n 'Number.isFinite(cp.d)) continue'  scripts/pipeline3.js   # L3764，唯一没有日志的

# 分母 + 六个日志名的次数。六项相加必须等于 654，否则这张表就过时了。
ls out/*/_log*.json | wc -l                                       # 136
for k in patchNoNet patchNoGeo patchCrossLayerNoObj patchedCrossLayer \
         patchIslandPair patchTooFar patchNoObj; do
  printf '%-22s %s\n' "$k" "$(grep -o "\"$k\"" out/*/_log*.json | wc -l)"
done
# 期望：0 / 0 / 0 / 0 / 1 / 653 / 0  → 合计 654
```

### 3. 缝合失败：异常被收成一条字符串，错误因此不可定位

**现象。** 缝合阶段画线失败时，catch 只记 `e.message` 的前 120 个字符。没有网名、没有端点坐标、没有图元 id。

**代码位置。** `scripts/pipeline3.js:2359-2388`。try 块里唯一的 API 调用是 L2200 的 `eda.pcb_PrimitiveLine.create(...)`；L2207 已经有 `mId` 保护——代码是**读返回值**判断失败的，不是靠异常；L2224 的 catch 只有 `log('stitchErr', String(e && e.message).slice(0, 120))`。

**语料里观测到什么。** `stitchErr` **37 次**，**全部字面等于** `Cannot read properties of undefined (reading 'primitiveId')`，分布在 7 个目录；每一条都紧跟在 `stitchAnchors` 之后、任何一条 `stitch` 成功之前。

**影响。** 这句 `read 'primitiveId'` 指向宿主侧 `create` 的返回对象为 `undefined`（`api/methods.csv:372` 把 `pcb_PrimitiveLine.create` 记为 public）。**这是位置判断，不是证明**：日志里不带 `from`/`to`/`net`，无法把这条错误对到具体线段，也无法判断是「返回 undefined」还是「返回了但没这个方法」。要让这条可诊断，catch 必须带上调用参数。

**怎么自己核对。**

```bash
grep -n "stitchErr\|getState_PrimitiveId" scripts/pipeline3.js
grep -o '"stitchErr"' out/*/_log*.json | wc -l                                   # 37
grep -o "Cannot read properties of undefined (reading 'primitiveId')" out/*/_log*.json | wc -l
```

### 4. `fixed` 数的是「API 接受了」，不是「间距变好了」

**现象。** `clearanceRound` 同一行里印两个数：`violations`（板上还剩几处）和 `fixed`（本轮调用成功几次）。后者与前者不同源，看起来却像「修了 N 处、剩 M 处」。

**代码位置。** `scripts/pipeline3.js:4215` 落盘 `{ round, violations: clears.length, fixed }`；L4030-4032 的注释原文：

> 判据只看**板上结果**，不问动作成不成功：fixed 数的是"变更 API 接受了"，
> 与"这处间距真的变好了"脱钩（本文件里 modify/delete 失败都是返回值不是异常，
> 所以 fixed 从来只能证明"调用没报错"）。违规数连续两轮不降 = 这个方向修不动了。

退出判据在 L3450-3456：违规数连续两轮不降，就记 `clearanceNoProgress` 并 `break`。

**语料里观测到什么。** 审计记录 5 例。当前能直接核对的一例是 `out/AI_稳压板_7pf5gw-20261126-070858/_log-1-smart-fit.json`：r0 `v=3 / fixed=2` → r1 `v=3 / fixed=2` → r2 `v=3 / fixed=1`，收于 `clearanceNoProgress{"round":2,"violations":3,"stuckAt":3,"fixes":5,"rounds":3}`。三轮里违规数一直是 3，`fixed` 累计涨到 5。

**注意。** 全仓 grep 不到 `modified but not reduced` 这个字面字符串——它是对计数器的解读，不是代码里的字符串，不要当成代码引用。

**影响。** 只要 modify 返回 true 就 `fixed++`，于是「修了 5 处」与「一处没修好」可以同时为真。这是本项目最干净的一条「计数器统计 API 接受」样本。

**怎么自己核对。**

```bash
grep -n "clearanceRound\|noProgressRounds\|clearanceNoProgress" scripts/pipeline3.js
grep -o '{"s":"clearanceNoProgress"[^}]*}' out/*/_log*.json
```

### 7. `coverage` 算完只进日志，没有任何动作或闸门读它

**现象。** 判断「过孔盘有没有盖住线端」的那几个数，算出来、写进日志，然后就没有下文了。

**代码位置。** `scripts/pipeline3.js:4604-4619`：L4408 `let coverage = null` → L4410-4417 算 `r = dia/2`、`dEnd`（末端到孔心的最小距离）、`covered` → L4419-4422 把 `coverage` 放进 `log('patchIslandPair', ...)` → L4423 `continue`。全文 `coverage` 只此一处赋值、一处构造、一处进日志（L4408 / L4416 / L4421），都在同一个块内，没有第四处读取。

**语料里观测到什么。** `patchIslandPair` 仅 **1** 条，且带 `coverage` 字段。

**影响。** 「过孔盘覆盖不足」这个假设至今**没有被任何动作或闸门使用过**。它现在的作用只是让日志里多一个字段；把它读成「已经处理了覆盖问题」是错的。这一条与第 2 条同源：观测到的量不进入判定，判定就不会因为它改变。

**怎么自己核对。**

```bash
grep -n "coverage" scripts/pipeline3.js        # 代码只有 3823 / 3831 / 3836，另有一处注释 1406
grep -o '"patchIslandPair"' out/*/_log*.json | wc -l   # 1
```

### 8. `rulesApplied` 只是一个尺寸命中判断，不进 `_run.json`、不参与判定

**现象。** 日志里有一条 `routeRulesProof`，带 `rulesApplied: true/false`，读起来像「走线规则生效了没有」。它其实只是「成品过孔里有没有一对尺寸等于我们指定的 h/d」。

**代码位置。** `scripts/pipeline3.js:1429` `const specHit = pairs.some(...)`；L1344 `rulesApplied: specHit`。全文件只有这一处赋值，没有分支、没有后续改写。

**语料里观测到什么。** `routeRulesProof` **136 条**：`true` **106** / `false` **30**（22% 的跑法里 rules 没生效）。该字段不进 `_run.json`（`gates` 里没有它），也不参与任何判定。

**影响。** 「把配置传进去 ≠ 生效」成立：22% 的跑法里，指定的过孔尺寸没有出现在成品上。但「它导致了间距问题」是**推论**，语料没有给出关联证据——`rulesApplied=false` 的跑法与最终 DRC 结果之间没有被统计过。

**怎么自己核对。**

```bash
grep -n "rulesApplied\|specHit" scripts/pipeline3.js
grep -o '"rulesApplied":true'  out/*/_log*.json | wc -l   # 106
grep -o '"rulesApplied":false' out/*/_log*.json | wc -l   # 30
```

### 10. `_run.json` 写的是布局前的声明板框，扩板后从不回写

**现象。** 板框在布局后被撑大，产物目录里的 `_run.json` 仍写着设计声明的原值。任何拿它当「本次实际板框」的下游都会比错对象。

**代码位置。** `scripts/pipeline3.js:663` `const bw0 = D.boardWidthMil || 1000, bh0 = D.boardHeightMil || 800;`——是 `const`，全文件 15 处引用里没有一处赋值，所以它**不可能**被回写。L716-795 的 `outlineFit` 在装不下时会扩板并算出 `outlineInfo`（`{ow, oh, stage:'expanded'}`，见 L769-790），但 `bw0`/`bh0` 一直是布局前的原值；L4468 与 L4524 写出的都还是 `bw0`/`bh0`。

更有意思的是 L4462-4463 这两行注释自己打架：

> 把本次**实际生效**的板框等信息落盘到产物目录，作为独立校验的唯一可信来源。
> 自愈会放大板框，设计文件里的原值已不代表本次实际使用值。

第一行说要写「实际生效的板框」，第二行承认「原值已不代表实际使用值」——而代码写的是 `bw0`，即第二行。注释的意图没有落到代码上。

**外部印证。** `scripts/fabcheck.js:444-445`：

> 实测（106 个目录）：`outlineFit.fits=false` 的目录里 Gerber 总比 `_run.json` 大 —— 那是声明没有回写，属记录缺陷。

fabcheck 因此只报 `W('gerber.outline.size')`，不报 blocker：PCB 厂按 Gerber 生产，不按 `_run.json`。

**语料里观测到什么。** 以 `AI_OLED_底板_5p5g6m-20261126-071309` 为例：`_log.json` 里 `outlineBBox` 是 `{x0:320.05, y0:-1110.6, w:2041, h:1531}`，同一份日志里 `outlineExpandPlan.baseTheory` 仍是 `[1000,750]`，`_run.json` 也写 `1000×750`。

**影响。** 板框真值在 Gerber 里，不在 `_run.json` 里。把 `_run.json` 当权威，会让「声明与实际不一致」这件事永远显示不出来，也会让按它做尺寸对齐的检查一直在比错对象。

**怎么自己核对。**

```bash
grep -n "bw0\|bh0" scripts/pipeline3.js | head -20
grep -o '"outlineBBox":{[^}]*}' out/AI_OLED_底板_5p5g6m-20261126-071309/_log.json
node -e "const j=require('./out/AI_OLED_底板_5p5g6m-20261126-071309/_run.json');console.log(j.boardWidthMil,j.boardHeightMil)"
```

### 12. 流水线自身不查图元绝对坐标是否出框

**现象。** 器件被摆到板框外时，流水线不会发现。它只做两件事：比器件跨度、装不下就扩板。
**代码位置。** `scripts/pipeline3.js:808-809`：注释明确「不用绝对坐标比较」，判据是 `spanW <= bw0-40 && spanH <= bh0-40`（器件跨度 vs 板框尺寸，在 L812）。L817-880 只处理「装不下 → 删旧板框、等比扩板」（`outlineExpandPlan` 在 L867）。全文 grep `outside` 只命中语义无关的走廊变量名。

**真正的出框判定在离线校验器里。** `scripts/fabcheck.js:463-468`：

```js
const out = g.coords.filter((c) => c.x < board.minX - EPS_MM || c.x > board.maxX + EPS_MM || c.y < board.minY - EPS_MM || c.y > board.maxY + EPS_MM);
if (out.length) {
  if (COPPER_LAYERS.includes(ext)) B('gerber.coord.outside', ...);
  else W('gerber.coord.outside.silk', ...);
}
```

（上面 `B`/`W` 的参数省略了证据对象，完整见 L463-468。）

**语料里观测到什么。** 这类缺陷只能靠离线校验器发现。本语料里没有把它伪装成通过：`out/_probe/fab-census.json` 的 `blocked_but_self_ok` 是 `[]`——危险方向 0 次（没有「自述通过但实际阻断」的目录）。

一个能同时看到两侧的例子：`out/AI_OLED_底板_5p5g6m-20261126-071309` 的 `_run.json` 里 `gates.outlineOk` 是 **true**（它只比器件跨度），而 `fabcheck` 对同一目录报 8 条阻断，其中 `gerber.coord.outside` 四条：GTL 23 个、GBL 12 个、GTS 18 个、GBS 12 个、GTP 22 个图元落在板框外，外加 `drill.outside` 15 个孔、`pnp.outside` 5 个器件中心出框。板框闸门说「合适」，板子实际做不出来。

**影响。** 诊断顺序要对：先看 `fabcheck`，再看流水线日志。反过来说，`outlineOk:true` 只证明「器件跨度没超板框尺寸」，不证明「没有东西在板框外」——这两句话差得很远。

**怎么自己核对。**

```bash
grep -n "outside" scripts/pipeline3.js
grep -n "gerber.coord.outside" scripts/fabcheck.js
node -e "const c=require('./out/_probe/fab-census.json');console.log(c.blocked_but_self_ok)"
```

### 13. README 生成脚本：动态值算完，散文里写死「两目录」

**现象。** 生成脚本用动态值算出「几个目录、几条阻断」，紧接着在下一句散文里把「两目录」写成常数。落盘后同一段自相矛盾。

**代码位置。** `out/_probe/sync-readme-numbers.py:153-154` 用动态值：`A["fab_blocked"]`、`sum(blk.values())`、`len(blk)`；L155-156 紧接着写死：

```python
L.append("  **不是流水线没跑完**（两目录 `_run.json` 齐全、`ok=false`），"
         "是几何自洽这一步没过。")
```

落盘结果即 `交付-README.md:44-45`：「那 **3** 个目录的 20 条阻断…／**不是流水线没跑完**（**两目录**…）」——同一段里 3 与 2 并存。

**语料里观测到什么。** 实测阻断目录是 **3** 个（`fab-census.json` 的 `self_ok_false.fab_blocked = 3`）。**另**：该脚本只存在于 `out/_probe/`，`scripts/` 下不存在同名文件。

**影响。** 生成器每跑一次，就把同一个矛盾复制一次；而这段散文是给人读的结论区，读者会先信它。

**怎么自己核对。**

```bash
grep -n "两目录" out/_probe/sync-readme-numbers.py 交付-README.md
ls scripts/sync-readme-numbers.py          # 不存在
node -e "const c=require('./out/_probe/fab-census.json');console.log(c.all)"
```

### 14. `fabcheck` 的四类结果同台输出，正则统计会把阻断数放大

**现象。** `blockers`、`warnings`、`notes`、`passes` 四个数组都进同一份 JSON，且四个构造函数都以 `id` 作为第一个键。用正则数 `"id"`，数到的是四类结果的总和。

**代码位置。** `scripts/fabcheck.js:312-319`：

```js
const B = (id, msg, ev) => blockers.push({ id, level: 'blocker', msg, evidence: ev });
const W = (id, msg, ev) => warns.push({ id, level: 'warn', msg, evidence: ev });
const N = (id, msg, ev) => notes.push({ id, level: 'note', msg, evidence: ev });
const P = (id, msg, ev) => passes.push({ id, level: 'pass', msg, evidence: ev });
```

输出在 L764-786：`blockers / warnings / notes / passes` 四个数组平铺在同一个对象里。

**语料里观测到什么。** 区分大小写的调用点数：`B(` 38、`W(` 14、`N(` 6、`P(` 14。审计记录里 `B(` 写的是 39——多出的那 1 个来自 `grep` 默认不区分大小写，把 L168 正则里的 `b(` 也算进去了；这类计数必须逐行核对，不能凭印象。

**根因是结构性的：每个结果条目恰好有一个 `id`。** 所以正则数 `"id"` 数到的是**四个数组的总和**，与阻断数无关。

一个干净目录的直接读数（`scripts/fabcheck.js out/AI_RP2040_系统-20261125-033939`，测于 2026-11-26T13:0x）：`blockers` 长度 **0**、`warnings` **4**、`notes` **5**、`passes` **11** —— 合计 **20** 条，`"id"` 正好 **20** 次。四个数组逐一对账：`warnings` 4 条 / 4 次、`notes` 5 条 / 5 次、`passes` 11 条 / 11 次。

**所以「~19 倍」这个说法本身是错的**（本节先前把它标成「推算，没有实跑复算」，这次补上了）。20 是**条目总和**，不是倍数；分母是 0 时倍数根本不存在。能算倍数的只有带阻断的目录：`examples/d1` 是 1 条阻断 / 22 次 `"id"` = **22 倍**。

对 4 个干净目录实测（2026-11-26T13:0x）：`"id"` 分别 20 / 19 / 18 / 19，阻断数全 0。**量级对，倍数是错的说法**——它在零阻断的板子上会报出十几条「阻断」，而那正是最容易把可下单的板子判死的地方。

**影响。** 用正则统计阻断数会得到数量级错误，而且错的方向是「看起来更糟」，容易把可下单的板子判死。

**正确读法**（两个入口的输出形状不一样，别混）：

- `scripts/fabcheck.js <dir>` 打 JSON：`blockers / warnings / notes / passes` 都是**数组**，`verdict` 是 `PASS|FAIL`，`exit` 是 0/1。取 `Array.isArray(j.blockers)`。
- `cli/pcb.mjs fabcheck <dir>` 打的是**摘要对象**：`{orderable, exitCode, blockerCount, blockerIds, blockers, warnings, raw}`，其中 `blockers` 是**拼接好的字符串**、`blockerIds` 才是数组。对着 CLI 取 `j.blockers.length` 得到的是字符串长度，不是条数。

**怎么自己核对。**

```bash
grep -n "const B = \|const W = \|const N = \|const P = " scripts/fabcheck.js
grep -o "B('" scripts/fabcheck.js | wc -l
node scripts/fabcheck.js out/AI_RP2040_系统-20261125-033939 \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('blockers',j.blockers.length,'warns',j.warnings.length,'notes',j.notes.length,'passes',j.passes.length)})"
```

### 15. `_run.json.ok` 与「可下单」不是同一批

**现象。** `ok=true` 的目录数（48）与可下单的目录数（53）不相等，而 `ok=true` 集合里的 48 个恰好全部可下单——两个 48 相等是巧合。

**代码位置。** `scripts/fabcheck.js:764-771`：`const verdict = blockers.length ? 'FAIL' : 'PASS'`；`exit: blockers.length ? 1 : 0`。判据同源：有阻断就退出 1。

**语料里观测到什么。** `fab-census.json` 的 `self_ok_true = {n:48, fab_ok:48, fab_blocked:0}`、`self_ok_false = {n:8, fab_ok:5, fab_blocked:3}`，`rows` 里 `fab_exit` 分布 `{0:53, 1:3}`。即：`ok=true` 的 48 个**全部**可下单（危险方向 0）；但可下单总数是 **53**，多出的 5 个来自 `ok=false` 目录。

**影响。** 拿 `_run.json.ok` 当「能下单」会在 5/56 上给出悲观结论（明明可打样却判失败），并在结构上给出危险结论（`ok=true` 但阻断的方向没有任何机制阻止，只是这次恰好 0 次）。两个问题不同：`ok` 回答「流水线自己跑完了没有」，`fabcheck` 退出码回答「能不能下单」。

**怎么自己核对。** 从普查里挑一个 `fab_exit=0` 的目录，再拿 `ok=true` 的目录对比：

```bash
node -e "const c=require('./out/_probe/fab-census.json');for(const r of c.rows)if(r.fab_exit===0){console.log(r.dir);break}"
node scripts/fabcheck.js out/AI_RP2040_系统-20261125-033939 > /dev/null; echo $?   # 0
node scripts/fabcheck.js out/d1 > /dev/null; echo $?                                # 1（copper.thin）
```

固定目录当「通过样本」本身会过期（`out/d1` 现在就是 1），所以每次都从普查里挑。

### 16. 布线变体阶梯：7 份引擎配置里有 5 份从来没被执行过

**现象。** 代码里写了一串「退路」引擎配置（去掉铺铜、只留层、什么都不带），
设计意图是「这份配置布不通就换下一份」。但它们几乎从来不会被执行 ——
因为**决定是否继续的是作业自报的状态，不是板子通没通**。
而起不到作用时作业自报的状态是 `completed`。

**代码位置。** `scripts/pipeline3.js` 的 `variants` 数组（7 项）与
`for (const v of variants)` 循环里的 `if (r.state === 'completed') break;`。
同一文件里另一处注释已经把正确的判据写死了：

> 布线器作业的 state 说的是「作业怎么结束的」，闸门问的是「板子通没通」。

但那一行仍在用作业状态代替连通性。变体阶梯只在作业 **TIMEOUT / ERR** 时才能往下走 ——
换句话说：**唯一能触发退路的路径，是布线器超时。**
而「这份配置布不通」这件事，布线器恰恰报成「我跑完了」。

**语料里观测到什么**（测于 2026-11-26T15:49+08:00，settle 0，扫 `out\` 全部含 `route` 事件的目录）：

| 变体 | 真正执行过的目录数 |
|---|---|
| `margin+ground+pours+keep`（variants[0]） | **132 / 132** |
| `margin+ground+keep`（variants[1]） | 3 / 132（同一个目录的 3 个 attempt 文件） |
| `ground+pours+keep` 及其后 4 份 | **0 / 132** |

即 7 份配置里有 **5 份在 132 个目录里一次都没执行过**。

**一次完整的空转**（`out\ESP32S3_Wireless_Mic_V2-20261126-152721`，26 器件 / 111 连接 / 1000×3700 mil）：

```
route      {"iter":0,"variant":"margin+ground+pours+keep","state":"completed","ms":7270}
routeIter  {"iter":0,"stillUnconnected":121}
route      {"iter":1,...同上...}   routeIter {"iter":1,"stillUnconnected":121}
route      {"iter":2,...同上...}   routeIter {"iter":2,"stillUnconnected":121}
routeEscalate {"reason":"FAST 3 轮后仍有断连，升级 COMPLETION 兜底"}
route      {"iter":3,"variant":"margin+ground+pours+keep","state":"completed","ms":8464}
routeIter  {"iter":3,"stillUnconnected":121}
```

4 次全部 `completed`、6~9 秒、断连数**一动不动**。
同一次运行的 `drcLeaves.byNet` 显示 28 个网络每个恰好 2 处断点 —— 每个网络的两端焊盘都没被碰过，
即**一条走线都没画**。而 4 轮 × 7 变体 × 8 秒的预算就这样烧掉了。

**影响。** 两个：

1. 「配置太严导致布不通时还有退路」这个安全性论证**没有在语料里成立过一次**。
   退路存在，但只有超时才走得到。
2. 一条走线都没画时，`stillUnconnected` 在场次间完全不变，而外侧的 4 轮重试
   只是把同一件事重复 4 次。重试阶梯「越重试越差」那条结论在这里表现为**空转**，
   不是变差 —— 因为什么都没发生。

**怎么自己核对。**

```bash
# 每个变体被多少目录真正执行过
for v in margin+ground+pours+keep margin+ground+keep ground+pours+keep margin+keep-only keep-only ground+pours plain; do
  printf '%-28s %s
' "$v" "$(grep -l ""variant":"$v"" out/*/_log*.json 2>/dev/null | wc -l)"
done
# 单次空转的三个数：耗时 / 断连 / 走线增量
node -e "const j=require('./out/ESP32S3_Wireless_Mic_V2-20261126-152721/_log.json');
for(const e of j.entries) if(/^route|^routeIter|^routeEscalate/.test(e.s)) console.log(e.s,JSON.stringify(e.v))"
```

### 17. 判据从「自报 state」换成「真实新增走线」：方向对，代价错 —— 7 份各烧满 120 s 换来零走线

**已做的修法**（`pipeline3.js`，2026-11-26 15:44 落地）：判据换成
「**本变体真实新增的走线数**」—— 新增 0 条就换下一份配置，新增 >0 条保持原有 break
（无脑多轮会让间距违规翻 6 倍，那条结论没被推翻）；读不出来归 −1 走保守分支，
绝不把「未知」当成「产出 0」。另加一条：一整轮 7 份配置合计 0 条走线就直接结束轮次循环。

这一改动**在写下这段时还没有被任何一次运行验证过** —— 下一次跑通/跑不通的日志才算证据。

**2026-11-26T15:44 的第一次验证：判据方向对，代价错。** 运行
`out/ESP32S3_Wireless_Mic_V2-20261126-154422`（26 器件 / 111 连接 / 1000×3700 mil，
预算 `totalMs=1740000`，settle 无，663 条事件），7 次 route 读数是：

| # | 变体 | state | ms | linesAdded |
|---|---|---|---|---|
| 1 | margin+ground+pours+keep | TIMEOUT | 120681 | 0 |
| 2 | margin+ground+keep | TIMEOUT | 120687 | 0 |
| 3 | ground+pours+keep | TIMEOUT | 120828 | 0 |
| 4 | margin+keep-only | TIMEOUT | 120799 | 0 |
| 5 | keep-only | TIMEOUT | 120765 | 0 |
| 6 | ground+pours | TIMEOUT | 120985 | 0 |
| 7 | plain | TIMEOUT | 120946 | 0 |

读数里有两件事：

- **阶梯真的醒了。** 上一版 `if (r.state === 'completed') break;` 下，
  全语料 143 个目录里 129 个只出现过 `variants[0]` 一个名字；这一轮 7 份全跑了。
- **零产出。** 7 份全部 `linesAdded: 0`，`routeAllVariantsNoOp {iter:0, variants:7,
  stillUnconnected:121}`。845 s 换来 0 条走线。
- **极差 304 ms。** 七个耗时全在 120.7~121.0 s 之间，精确撞在同一个上限上。
  同极差只有一个解释：限制因素是**时间**，不是引擎配置。换配置不会让它更快，
  只会把同样的 120 s 再烧一遍。

代价按下表分摊（phase 增量的分母是 1726.1 s）：

| 阶段 | 增量 | 占比 |
|---|---|---|
| `autoRouting`（7 份阶梯） | 937.1 s | 54.3% |
| `patchDrc` | 216.8 s | 12.6% |
| `stitchGaps` | 204.4 s | 11.8% |
| `drc` | 135.1 s | 7.8% |
| `fixClearance` | 97.7 s | 5.7% |
| `autoLayout` | 44.3 s | 2.6% |

于是 `drc` 只剩 135 s、`connBeforePour {leftMs: 118829}`，
**导出 0/6，六个文件的 `skipped` 全是 `budget`** —— 这一轮连一个可打样产物都没产出。

**根因：两件不同的事被写进了同一个分支。** `state` 回答「作业怎么结束的」，
`linesAdded` 回答「板子有没有多一条线」，而处置取决于**组合**：

| state | linesAdded | 含义 | 处置 |
|---|---|---|---|
| `completed` | 0 | 这份配置在这块板上布不出来（算完了是空的） | 换下一份配置 |
| `completed` | >0 | 有产出 | 保持 break，不加轮次 |
| `TIMEOUT` | 0 | **没算完**，什么也没学到 | 换配置没用；要么给时间，要么收手 |

**已做的修法（`pipeline3.js`，2026-11-26T16:20 落地，sha `DC96A26B5228` → `F75F8090C06D`）。**
按「超时且零新增走线」计数，连续 2 次就 `break` 出阶梯并留证据：

```js
if (r.state === 'ERR' || (r.state === 'TIMEOUT' && linesAdded !== null && linesAdded === 0)) {
  timeoutNoOpStreak++;
} else { timeoutNoOpStreak = 0; }
if (timeoutNoOpStreak >= 2) {
  log('routeLadderAbort', { iter, after: routeAttempts.length, streak: timeoutNoOpStreak,
    tried: routeAttempts.map((a) => a.variant), notTried,
    why: '连续 2 次超时且零新增走线 —— 限制因素是时间不是配置，换配置不会更快',
    savedMsApprox: Math.max(0, notTried) * 120000 });
  break;
}
```

阈值取 2 不取 1：一次超时可能是机器抖动；两次撞同一个上限、且一条线都画不出来，
那是这块板的信息。日志写 `notTried` 而不是只写「试过了」——
否则读日志的人会把「收手」误读成「7 份都试遍了」。

**这条修法本身在写下这段时也还没有被运行验证过。** 记录在这里，
等下一次运行的 `routeLadderAbort` 事件来判。

**更上游的问题没有解决。** 上面的补丁只让**代价**变小，没有让板子通。
7 份配置在 120 s 内一条走线都画不出来，这件事仍未解释：
同一套网络在 v1（自动布局，2600×1900 mil = 69538 mil²/连接）上能到
`stillUnconnected: 10`。所以「布不出来」不是这张网表的天性，
而是本版板形/摆放的某个具体约束。

### 18. 焊盘落在板框外，而「跨度」判据把它报成「只差 48 mil」

`outlineFit` 的 `fits` 比的是焊盘 bbox 的**尺寸**，不是位置：

```js
const fits = padN > 0 && spanW <= bw0 - 40 && spanH <= bh0 - 40;
```

实测 2026-11-26T15:44（`out/ESP32S3_Wireless_Mic_V2-20261126-154422`，
padN=159，板框 1000×3700 mil）：

```
outlineFit               {padN:159, bbox:[73,-3827,855,-119], span:[782,3708], board:[1000,3700]}
outlineFit.explicitFixed {board:[1000,3700], span:[782,3708], over:[0,48]}
antennaKeepout.overhangDetail {des:'U1', boardMinY:-3705, partMinY:-4117.5, partMaxY:-3087.3}
```

三件事同时成立：

- 板框底边实测 **-3705**；
- 全部焊盘最低点 **-3827**；
- ⇒ **122 mil（3.1 mm）的焊盘整排挂在板框之外**；
- 而判据报的是「跨度超 48 mil」—— 一个听起来像「只差一点」的数。

尺寸略大和位置错位被混成了同一句话。位置才是致命的那个：挂到板外的焊盘
没有任何可连的端点，布线器对它们一条线都画不出来。

**根因是封装原点。** ESP32-S3-WROOM-1 的原点在**焊盘区中心**，不是本体中心：
同一轮 EDA 报本体 bbox `[-4117.5, -3087.3]`（中心 -3602.4），而摆放坐标是 -3467，
偏 **135.4 mil** ≈ `(1030-748)/2 = 141`。布局表按「原点在本体中心」算，
于是整体往上错了 141 mil。

**修法**（`scripts/pipeline3.js:823-840`）：判位置，不判尺寸。新增
`padOffBoard` 事件，逐边打 `left/right/bottom/top` 的越界量，超过
`PAD_OFFBOARD_TOL = 50` mil 就让整轮失败。容差取 50：远大于板框线宽与取整
带来的几个 mil，又远小于实测的 122。

**这条判据截至写下这段（2026-11-26T16:40 +08:00）还没有跑过。**

### 19. 天线净空带盖住模组自己的焊盘，出线被整段封死

`antennaKeepout` 原来只查一件事：**别的**器件有没有闯进净空区（`intruders`）。
它不查这条带子有没有压住被豁免模组**自己的焊盘**。

原设计给的带子是 `{"x0":0,"x1":1000,"y0":-3700,"y1":-3460}` ——
240 mil 高、横贯全板。而 U1 的焊盘区在 **-3835…-3087**，相当一批焊盘正落在带子里。
带子建的规则是 `ruleType:[5,6,7]` = `NO_WIRES / NO_FILLS / NO_POURS`，
于是这些焊盘的**出线方向被整段封死**。

实测 2026-11-26T16:20（`out/ESP32S3_Wireless_Mic_V3-20261126-162010`，1300×3700）：
这一轮**布通了**（`tracksAdded` 合计 602、导出 6/6），但 DRC 叶子分布里有一组
专属于这条带子：

```
Clearance Error | Prohibited Region to Track   7
```

7 条全部落在 `y = -3459 / -3513 / -3568`，也就是带子下沿 -3460 附近 ——
走线从模组焊盘往上出，撞在这条本不该存在的边界上。

**修法**（`scripts/pipeline3.js:996-1012,1031-1035`）：
1. 带子收窄到 13 mil（`-3700…-3687`），正好卡在模组焊盘外沿之外；
2. 新增 `padsInBox` 计数：净空带里只要还有焊盘就报错，并列出 5 个坐标样本。
   判据不看器件归属，只用一条更强的性质 —— **禁布区里有焊盘 = 这个网络的唯一出口被封死**。
   只在 `allowDesignators` 非空时启用（那就是天线净空带），窄范围，不越界。

**这条判据同样是新加的，截至 2026-11-26T16:40 +08:00 还没有跑过。**

### 20. 「7 份配置零走线」不是布线器的问题，是板宽

这是第 17 条结尾那个未解问题的答案。

同一份网表（26 器件 / 111 连接 / 27 网络），只是板宽不同：

| 运行 | 板框 | 布线结果 | 用时 |
|---|---|---|---|
| `ESP32S3_Wireless_Mic_V2-20261126-154422` | 1000×3700 mil | 7 份配置 `tracksAdded` 全 0，`stillUnconnected` 停在 121 | 1740 s 全烧在阶梯上 |
| `ESP32S3_Wireless_Mic_V3-20261126-162010` | 1300×3700 mil | iter0 一次画 **431** 条，`stillUnconnected` 122 → **27** | 561.7 s（预算的 32%） |

1300 那一版的逐轮读数：

```
routeIter {iter:0, stillUnconnected:122, tracksAdded:431}
routeIter {iter:1, stillUnconnected: 81, tracksAdded: 12}
routeIter {iter:2, stillUnconnected: 81, tracksAdded:  4}
routeIter {iter:3, stillUnconnected: 27, tracksAdded:155}   ← COMPLETION 保底轮
```

只有 +300 mil 的差别，产出从 **0 条**变成 **602 条**。

**为什么。** ESP32-S3-WROOM-1 的封装宽 **748 mil**。板宽 1000 mil 时两侧各剩
`(1000-748)/2 = 126` mil 的逃逸通道，按 `MARGIN_RULES`
（`clearance:8 / padClearance:8 / edge:15 / width:10 / via{d:24,h:12}`）
只放得下约 4 条走线，而 41 个引脚里有 35 个要从这片窄带往外走。
1300 mil 把通道加宽到 276 mil。

**这一条不改代码。** 它改的是「板宽是设计意图」这个前提：`outlineFit` 在显式
摆放模式下拒绝放大板框是对的（第 10 条的反面），但它同时意味着**板宽选错时
没有任何东西会提醒你**。所以 `padOffBoard` 与逐轮 `tracksAdded` 是唯一能在
早期看出「这块板根本布不出来」的两个读数 —— 前者判几何，后者判产出。

**引用的分母。** 0 条与 602 条的分母都是「本轮 `pcb_PrimitiveLine` 数量差值」，
不是「连上的网络数」；27 与 121 的分母都是 DRC 报出的断连叶子数。两组数不同源。

### 8 的补记（2026-11-26T15:44 落地）

上面第 8 条写的 `rulesApplied` 用**一个字段表达了两个意思**，已改成三态：

- 它数的是全部过孔，而其中通常是 `ground.epVias` 打出来的 EP 地孔
  （实测 `epViaAt` 的 `near` 值 19.4~25.6 —— EP 地孔尺寸由 `ground.epVias` 控制，
  本来就不受 `rules.via` 约束）。
- 所以 `false` 只证明「没有过孔符合 spec」，**不能**证明「rules 被引擎忽略了」。
  尤其布线器一条走线都没画时，根本不存在信号过孔，此时对 `rules.via` 无从判断。

现在输出 `verdict: applied | ignored | unmeasurable` 加一句 `why`，旧字段改名
`specViasPresent`（只表示「有 spec 过孔」这一件事）。第 8 条正文里的 106/30 是一份
**2026-11-26 早于本次改动**的测量，仍然成立，但它回答的是旧字段的问题。

## 二、部分成立（部分真）

### 1. `skippedNoAnchor` 全为 0：字段是真的，「健康」是半结构性的

**成立的那一半。** 字段真实存在并被写进日志：`scripts/pipeline3.js:2248` 声明 `let skipNoAnchor = 0, skipTooFar = 0`，L2183 在「断点离同层锚点超过 12mil」时自增，L2228 随 `stitchRound` 一起落盘。审计表里 **66 轮** `stitchRound` 的 `skippedNoAnchor` 全为 0。按同一判据在 2026-11-26 11:1x 对当前 56 个含 `_run.json` 的目录重跑一次（`--settle 180` 无关，这里是读盘统计），是 **78 轮、非零 0 次**——轮数变是因为语料被滚动过，结论同一个：一次都没触发过。

> **行号于 2026-11-26T19:48 重锚过（+497）。** 本节原先写的是 `1651,1686,1697,1731`，`patchE`/`patchF` 往 `pipeline3.js` 里插了 497 行之后全部失效。重锚不是加个常数就完事：六个锚点逐个按**内容**核对过 —— `2148` 确是 `let skipNoAnchor = 0, skipTooFar = 0`、`2183` 确是 `myD > 12` 自增、`2194` 确是 `!other` 分支、`2228` 确是 `stitchRound` 落盘、`2171`/`2173` 确是 `pool.length < 2`/`islands.length < 2`。
> **教训：** `test/doc-refs.mjs` 当时对本文其余十几处同样失效的引用**全部亮绿灯**，因为它只检查「被指到的那一行不是空的」。行号漂移后指向的往往是别人的代码，非空、合法、但完全无关。所以「引用能解析」不等于「引用指对了」—— 这条闸门的能力边界必须写明，不能拿它当引用正确性的证据。

**不成立的那一半。** 把这个 0 读成「找不到锚点这条路径被健康覆盖」不成立。L2194 的 `else skipNoAnchor++` 分支**在静态上恒不可达**：

```js
if (!other || otherD > MAX_GAP) { if (other) skipTooFar++; else skipNoAnchor++; continue; }
```

`other` 来自非空 `islands`；而 L2171 `if (pool.length < 2) continue`、L2173 `if (islands.length < 2) continue` 已经保证 `islands` 至少 2 个岛。遍历除 `myIsland` 以外的岛时，`other` 必然被赋值，所以 `!other` 永远为假，`else` 永远走不到。能自增 `skipNoAnchor` 的只剩 L2183。

所以「为 0」有一半是结构性的：它只说明「断点从没落在离最近锚点 12mil 之外」，并不说明「这条路径被走过并正常归零」。

计数管道本身是活的，`skippedTooFar` 在同一批轮次里不为 0（审计表记的是同一设计三轮 **24 / 84 / 22**）。当前 `out\` 里能直接看到的是另一组，例如 `out/AI_纯分立_17py4dl-20261126-064538/_log-1-smart-fit.json` 的三轮是 `0 / 42 / 42`，`out/Crystal_RTC_Clock-20261126-085027/_log-4-expand-1.25x-retry2.json` 是 `4 / 6 / 7 / 7`。数值会随语料滚动而变，要点不是具体数字，而是「同一轮里 `skippedTooFar` 非零、`skippedNoAnchor` 恒零」这个形状。

**影响。** 报「`skippedNoAnchor` 全 0，锚点命中率 100%」是过度解读；准确说法是「唯一可达的那条自增分支从未触发，另一条分支从未可达」。

**怎么自己核对。**

```bash
sed -n '1650,1700p' scripts/pipeline3.js
grep -o '"skippedNoAnchor":[1-9]' out/*/_log*.json | wc -l   # 0（非零一次都没有）
grep -o '"skippedTooFar":[1-9]' out/*/_log*.json | wc -l      # 非零
```

### 5. 「白名单」：收窄是真的，名单不存在

**成立的那一半。** 补线对象的筛选确实是逐级收窄的五道门：

- `scripts/pipeline3.js:4375`：只认 `errorType === 'Connection Error'`；
- L4311：还要有 `net` 与 `pos`；
- L4343：还要 `o1`/`o2` 两个对象几何都取得到，否则 `patchNoGeo`；
- L4358：`cp.d <= 1.0` 落入「孤岛/跨层」分支（跨层先打过孔，否则记 `patchIslandPair`）；
- L4426：`cp.d > 80` 放弃，记 `patchTooFar`（已吞 653 条）。

**不成立的那一半。** 「白名单 / allowlist / whitelist」这些词在 `pipeline3.js` 里**一次都搜不到**。它不是一个可列举的名单，而是「叶子形状 + id 可解 + 间距区间」的复合条件——每一道门都是对**对象**的判断，不是对**类型名**的查表。

**影响。** 写成「白名单」会让维护者以为改个数组就能放开某类断点，实际上要改的是几何可解性与间距阈值。措辞会把人引到错误的位置。

**怎么自己核对。**

```bash
grep -n "whitelist\|allowlist\|白名单" scripts/pipeline3.js   # 0 命中
sed -n '3590,3600p;3720,3730p;3750,3760p;3770,3780p;3835,3845p' scripts/pipeline3.js
```

### 11. 重试阶梯：机制上有预缩，语料里 0 次收缩

**成立的那一半。** 「重试阶梯能把板改小」有代码支撑。`run-all.ps1:562-564 "if ($baseArea -gt [Math]::Max($estArea * 2.2, $FIVExFIVE_MIL2)) {"` 是**预缩**分支：`if ($baseArea -gt [Math]::Max($estArea * 2.2, $FIVExFIVE_MIL2)) { $baseW = [int]($estSide * 1.15); ... }`。L565-571 才是放大。阶梯本身在 L683-726（`$healPlans` 的四个 @{w;h;tag}）：smart-fit 之后三档 `expand-1.25x / retry / retry2` 尺寸相同，只差 tag。

按 `designs/*.json` 复算，唯一触发预缩的是 `d7-rp2040-flash.json`（声明 2400×1800、11 器件 56 连）→ smart-fit 1212×1212、expand 1515×1515，**比设计声明小**。

**不成立的那一半。** 「语料里重试阶梯把板改小了」不成立。审计表在当时的 `out\` 快照（64 个目录、56 条 `_run.json`）里记 **0 次收缩转移**。按同一判据在 2026-11-26 11:1x 对当前语料重跑：**25 个目录有 ≥2 次 attempt，收缩转移 0 次**（目录数不同是因为 `out\` 被滚动裁剪过）。所有尺寸序列要么不变要么放大。`1400×1100 → 1750×1375` 是 `d11-crystal-rtc`，纯 1.25× 放大。收缩只发生在「设计声明 → 第一轮」这一跳，不发生在尝试之间。

**影响。** 两个结论必须分开写：机制存在（且只对一个设计生效）；语料没有观测到它在重试之间把板改小。合并成「重试阶梯会收缩板框」会让人以为失败后继续重试能缩小板子。

**怎么自己核对。**

```bash
sed -n '504,518p;536p;554p;561p;569p' run-all.ps1
node -e "const d=require('./designs/d7-rp2040-flash.json');console.log(d.boardWidthMil,d.boardHeightMil,d.components.length,d.connections.length)"

# 数连续 attempt 之间的收缩转移（按 _run-N 的数字序排，不是字典序）
node -e "const fs=require('fs');let seqs=0,shr=0;for(const d of fs.readdirSync('out')){const f='out/'+d;if(!fs.existsSync(f+'/_run.json'))continue;const s=fs.readdirSync(f).filter(x=>/^_run-.*json$/.test(x)).sort((a,b)=>(+a.match(/_run-(\d+)/)[1])-(+b.match(/_run-(\d+)/)[1])).map(x=>{const j=JSON.parse(fs.readFileSync(f+'/'+x,'utf8'));return [j.boardWidthMil,j.boardHeightMil]});if(s.length<2)continue;seqs++;for(let i=1;i<s.length;i++)if(s[i][0]*s[i][1]<s[i-1][0]*s[i-1][1]){shr++;console.log('SHRINK',d,s[i-1],'->',s[i])}}console.log('dirs with 2+ attempts:',seqs,'shrink transitions:',shr)"
```

## 三、被证伪的说法（假）

### 6. 「负 Y / 坐标 (1226.7,-1018.9) 是坐标系符号错」——不成立

**当初为什么会这么以为。** 布局产物里出现负 Y（例如 -671…-229、-1018.9），第一反应是「坐标系取反了」；而 `(1226.7,-1018.9)` 这个坐标又反复出现在调试记录里，看起来像一个系统性偏移的证据。

**实际是什么。** 负 Y 是布局产物的正常形态。`scripts/pipeline3.js:808-809` 的注释原文：

> 注意：布局产物常在负 Y（如 -671..-229），这**不是**问题 —— d1/d2/d3 都这样且全部通过。
> 唯一要判的是"器件范围是否超出板框尺寸"，用尺寸比较，不用绝对坐标比较。

而且 `(1226.7,-1018.9)` 全仓只出现在三个测试脚本里：`scripts/_test-snap-dot.js:65-75`、`scripts/_dbg4.js:14-15`、`scripts/_dbg5.js:10-11`。它是 d10 实测几何做成的**测试夹具字面**，不是流水线的输入或常量。`pipeline3.js` 全文没有 svg / y_cart / 取反逻辑。

另一侧也不成立：`scripts/fabcheck.js:415` 的 board 是从 GKO 自己的坐标取 ±范围（`Math.min(...xs)` / `Math.max(...xs)`），不存在「假设原点在 (0,0)」。

**证据在哪。** 上面三处夹具 + L729-730 的注释 + L415 的板框来源。

**怎么自己核对。**

```bash
grep -rn "1226\.7" scripts/ --include=*.js
sed -n '728,734p' scripts/pipeline3.js
grep -n "svg\|y_cart" scripts/pipeline3.js    # 无命中
sed -n '409,419p' scripts/fabcheck.js
```

### 9. 「Slot Region 完全没有处理分支」——不成立

**当初为什么会这么以为。** DRC 反复报 `Slot Region to Track`，而 fixClearance 挪不动它，于是推断「流水线根本不认识槽」。

**实际是什么。** 至少有五条独立路径在处理 Slot Region（下面按**事件名/函数名**定位，不再按行号 —— 行号会在任何一次插入后指错地方）：

- **`slotKeepout`（L1049-1114）**：把 MULTI(12) 的填充罩成禁布区。L1085 是 `eda.pcb_PrimitiveRegion.create(12, spoly, [5, 7], 'noWire-' + …)`；`let slotKeepout` 在 L1062，`log('slotKeepout', slotKeepout)` 在 L1114；
- **`slotKeepout.found === 0` 的分支（L1099 / L1127）**：专门区分「板上真没有槽」与「按 Fill 查错了层/类型」——不再猜，改成去普查 `pcb_PrimitivePad` 的孔型，把 `holeTypes`（实测本板 `{ROUND: 8, SLOT: 4}`）与 `npth*` 一起落盘；
- **`ensureGeoIdx()`（L2468）+ 按类试访问器（L2560-2644）**：先把 6 个类的 `getAllPrimitiveId()` 建成 id→类索引，再按 owner 试 `getState_ComplexPolygon` / `getState_Polygon`、用 `getSource()` 兜底，轮廓用 `discretize({ step: 5 })`（L2441）取点；
- **`slotPadGeometry()`（L2676）+ `slotHoleUsed`（L2897）**：DRC 报的 'Slot Region' 不属于任何已索引类时，用**真槽孔几何**（`getState_Hole()` 的 SLOT）替代与它无关的外接盒；配套的诊断是 `slotGeoCmp`（L2748 / L2763），它把 `violInFabricatedBox` / `violInRealHole` / `violInRealHoleOf` 三个判据分别落盘；
- **`noSideIsViaOrTrack()`（L3074）**：两侧都不是 Via/Track 时两个修复环都不认领，按 `uncovered` / `covered` 分桶（L3103，L3117 复用同一判据，避免判据写两遍）；把障碍类型落盘的则是 `log('trackRerouted', …)`（L3841）与 `log('clearanceNoHandler', …)`（L3861）。

语料 `trackRerouted` 里 `obstacleType:"Slot Region"` 出现 **22 次**——它确实作为障碍物被处理过。

**准确的表述。** Slot Region **作为障碍物已处理**。**作为被违规对象时**，有一角确实没有认领者：`clearanceNoHandler.uncovered` 里出现过 `SMD Pad×Slot Region` 与 `Hole×Slot Region`（当前语料里各见到 `n=1` 的一轮），两侧都不是 Via/Track——L2674-2677 的 `noSideIsViaOrTrack` 正是判据，所以两个修复环都不认领。而 `Slot Region to Track` 是 **covered** 的：`drcLeaves.byType` 的键写作 `Clearance Error | Slot Region to Track`，当前语料共 **25** 条；它有一侧是 Track，Track 环会认领。

**本次实测的一条新事实（会改变对这条的理解）。** 2026-11-26 的 v3 两次运行里，`Slot Region to Track` 的 10 条违规**全部落在同一个** 19 位 id `e9965320fba7ed20e37`（父图元 `e9965320fba7ed20`，`obWH [17,17]`、中心 `(650,-231)` ＝ 板宽正中、靠近板子上沿），而同一轮的 `slotKeepout` 普查是 `{found:0, created:0, holeTypes:{ROUND:8, SLOT:4}, censusEmpty:true}`：

- 板上有 **4 个真槽孔**（USB-C 屏蔽焊接槽，25×25 mil，位于 `(187,-2674)` 附近，网络 GND）—— 按 Fill 找槽那条路**一个都没找到**（`found:0`）；
- DRC 报的那个 "Slot Region" **不是**这 4 个槽孔中的任何一个：`violInRealHole:false`、`violInRealHoleOf:[]`，离最近的槽孔 2000+ mil。

所以「Slot Region」在这个 EDA 的 DRC 词汇里指的是**任何被当成槽/区的不规则图元**，不只是钻孔槽。把「查到 4 个 SLOT 孔」当成「已覆盖全部 Slot Region 违规」是错的。用 `ensureGeoIdx()` 把父图元 `e9965320fba7ed20` 解析成具体类别，是下一步要落盘的诊断。

**影响。** 「没有处理分支」和「有一类违规没人认领」是两件事，当初混成了一件。前者错，后者对。

**怎么自己核对。**

```bash
grep -n "slotKeepout\|slotHoleUsed\|Slot Region" scripts/pipeline3.js
grep -o '"obstacleType":"Slot Region"' out/*/_log*.json | wc -l   # 22
grep -o '{"s":"clearanceNoHandler".*' out/*/_log*.json | head
```

## 四、两个不该写进清单的「假红」

这两个现象看起来像缺陷，其实不是。写在这里，是因为它们各自被误判过一次。

### `node --check scripts/pipeline3.js` 会 exit 1，但不是语法错误

`scripts/pipeline3.js` 不是独立模块，而是宿主 `invoke` 的**顶层 await 函数体**。在 CommonJS 里直接 `node --check`，第一个顶层 `await`（L205）就会报 `SyntaxError: await is only valid in async functions and the top level bodies of modules`。

仓里真正的闸门有两处，都按「包装后的函数体」解析：`run-all.ps1:96 "try { new (require('vm').Script)('(async function(){'"`（不通过就回退上一次验证过的备份），以及全仓闸门 `test/syntax-gate.mjs`。后者在 `test/syntax-gate.mjs:10-12` 记了一张对照表：受跟踪 `.js` 186 个、`node --check` 失败 92 个（≥49%）、按真实形式解析失败 0 个。

也就是接近一半的 `.js` 在 `node --check` 下必然假红（这张表也随文件数变，别单独引用其中的数字）。看到一个红就去「修」，会修一个不存在的问题；学会忽略它，真正的语法错误也会被一起忽略。要查语法，跑 `node test/syntax-gate.mjs`。

### `_run.json.ok` 与 `pcb_fabcheck` 退出码不是同一件事

`ok` 回答「流水线自己跑完了没有」，退出码回答「能不能下单」。48 与 48 相等是**巧合**：`ok=true` 的 48 个全部可下单，但可下单总数是 53，多出的 5 个来自 `ok=false` 目录；两个集合不同，48 ⊂ 53。

把它们当成同一个判据，会在这 5/56 上给出悲观结论；更麻烦的是结构上允许「`ok=true` 但阻断」这种危险组合存在——本例中危险方向 0 次，但那是一次测量，不是保证。详见第 15 条。

## 五、这些缺陷的共同形状

1. **记录字段与判定脱钩。** `fixed`、`rulesApplied`、`coverage` 都是「记了，但没有任何闸门读它」。日志因此可以很丰富，而结论完全不受影响——字段的存在被当成了机制的存在的证据。
2. **异常被收成一条字符串。** `stitchErr` 37 次同一句，不带网、坐标、对象 id。一个本来可定位的错误，被降级成一个只能数出现次数的错误。错误处理的形状决定了事后能回答什么问题。
3. **闸门缺失处默认为通过。** `patchNoNet` 静默 `continue`；`skippedNoAnchor` 全 0 被读成健康；`clearanceNoHandler` 只打日志不阻断。没有闸门时，默认值的方向永远是「看起来没问题」，而「看起来没问题」与「问题不存在」在文件层面同形。
4. **计数器统计「API 接受了」，不是「问题解决了」。** `fixed` 数 modify 返回 true，`rulesApplied` 数尺寸命中，`stitch` 数 create 返回对象非空。三处都把「调用没报错」编码成了「缺陷已修」，而真正的判据（违规数、连通性）在另一个变量里，且常常更难看。
5. **判定分散在两个程序里。** 流水线不查绝对坐标出框，fabcheck 才查；`_run.json` 写声明值，Gerber 才是真值；`ok` 与退出码各答各的。没有任何一处同时持有两边的事实，所以「记录缺陷」只能靠离线校验器发现——而离线校验器的结论又常常只被读成一行 summary。

## 附：核对方式

以下命令都在仓库根执行，路径是仓库相对路径。

```bash
# 1. 定位一条结论的代码位置
grep -n "patchTooFar" scripts/pipeline3.js

# 2. 读某一段上下文（POSIX / PowerShell 等价，0 基偏移）
sed -n '3700,3730p' scripts/pipeline3.js
Get-Content scripts/pipeline3.js | Select-Object -Skip 3699 -First 31

# 3. 数一条日志在语料里出现几次（POSIX / PowerShell 等价）
grep -o '"patchTooFar"' out/*/_log*.json | wc -l
(Select-String -Path out\*\_log*.json -Pattern '"patchTooFar"' -AllMatches | ForEach-Object { $_.Matches.Count } | Measure-Object -Sum).Sum

# 4. 看某条日志的原始形状（不带缩进，可直接 grep）
grep -o '{"s":"clearanceNoProgress"[^}]*}' out/*/_log*.json

# 5. 复算可打样性（会重新扫一遍 out\）；只读已有快照则跑第二行
node cli/pcb.mjs census --settle 180
node -e "const c=require('./out/_probe/fab-census.json');console.log(c.all,c.self_ok_true,c.self_ok_false)"

# 6. 读 fabcheck 的正确姿势：结论看退出码，明细看数组
node scripts/fabcheck.js out/AI_RP2040_系统-20261125-033939 > /dev/null; echo $?   # 0
node scripts/fabcheck.js out/d1 > /dev/null; echo $?                                # 1（copper.thin）
```

`scripts/fabcheck.js` 输出 JSON（`blockers` 是数组）；`cli/pcb.mjs fabcheck` 输出摘要对象（`blockers` 是字符串、`blockerIds` 才是数组）。两个入口别混着解析。

**引用数字时带三样东西：** 分母（是「有 `_run.json` 的目录」还是「所有目录」）、时点（普查快照里的 `measured_at` 字段，**不是**文件 mtime）、窗口（`--settle` 的值）。三者缺一，数字下次就对不上。`out\` 会被 `scripts/cleanup.ps1` 按「保留最新 40 个 + 每个设计名最新 1 份」滚动裁剪，所以任何「N 个目录里 M 个…」都会随时间和清理动作变化。

## 六、2026-11-26 夜里新测出来的五条

### 21. `2>&1 | Out-String` 把日志并进 JSON，把一次成功构建判成 `NON_JSON`

**现象。** `out/ESP32S3_Wireless_Mic_V3-20261126-163653` 那次构建跑了 781.5 s，
`_run.json` 里 `routeState:"completed"`、`exportsOk 6/6`、`imported:true`、`outlineOk:true`，
`padOffBoard` 四项全 0 —— 也就是说**活儿干完了**。而 `run-all.ps1` 打印
`输出不是 JSON（NON_JSON 未知输出）`，然后 `重建 session` 并重跑了一整轮。

**根因（判别实验，不是推断）。** 探针 `F:\cache\temp\probe-stdout-encoding\probe.ps1`
在 pwsh 7.7.0、`[Console]::OutputEncoding = utf-8 (65001)` 下跑四种组合：

| 组合 | 结果 |
|---|---|
| `2>&1` + 默认编码 | **抛** `Unexpected character encountered while parsing value: l`，raw 头 80 字节 = `[log] routeIter iter=0\n{"ok":true,...}` |
| 只取 stdout + 默认编码 | 解析成功，中文正常 |
| 只取 stdout + 强制 utf8 | 解析成功 |
| stdout + `stderr` 重定向到文件 | 解析成功，stderr 文件内容 = `[log] routeIter iter=0` |

所以**编码不是原因，合流才是**。`cli/pcb.mjs` 第 6 行自己写着
「输出默认是单行 JSON（stdout），日志走 stderr —— 这样 `pcb fabcheck | jq` 永远可用」。
被测程序遵守了契约，是调用方把它拆散的两个流又粘回去了。

**为什么当时连原因都查不出来。** 解析失败时**没有留任何原始输出**（仓库里一个 `fail-*.txt` 都没有），
所以能拿到的全部线索就是 `NON_JSON` 这四个字。这跟 AGENTS.md
「量具读不到输入时不许沉默」是同一类错：它不是沉默，是**只留下一句没有内容的话**。

**还有一层。** 一个**本地解析**缺陷被报成了**会话**失败，于是唯一的处置是
`Reset-Session` + 整轮重跑。而预算是在多次尝试之间共享的（第一轮结束时
`budgetEnd {totalMs:1440000, leftMs:658460}`），所以这次误判直接吃掉了那次运行一半的实际工作量。
「工具不许把自己的输入/环境缺陷报成对被测对象的判决」—— 这条被违反了。

**已修。** `run-all.ps1` 新增 `Invoke-PipelineRaw`（stdout / stderr 分开取、强制 UTF-8 解码、
整体解析失败时抢救式抠出最外层 `{...}` 再试一次）与 `Save-InvokeFailure`（解析失败一定把两个流的
头 4000 字节落盘到 `fail-*.txt`）。五处捕获点统一走它，并加了一条残留检查：
**`invoke` 行里不许再出现 `2>&1`（注释不算）**。

三向证明（`F:\cache\temp\probe-stdout-encoding\prove.ps1`，从落地后的 `run-all.ps1` **原样抽出**函数体、
不手抄，配假 CLI）：

- A `stderr` 有噪声 + `stdout` 干净 → 解析成功，中文正确 ← 正是本次事故的形状；
- B `stdout` 前面还有一行垃圾 → 靠 `{...}` 抢救成功；
- C `stdout` 完全不是 JSON → **必须失败**（否则这段抢救就是个永不失败的假闸门）。

### 22. 强轮上限 6 比 4 差，而且 DRC 直方图跟布线结果无关

**实测。** 同设计、同板（1300×3700）、同一份脚本，前四轮逐字节一致，之后每次强轮一好一坏：

```
iter0 FAST  122 -> 72   tracksAdded 537
iter1 FAST   72 -> 72   tracksAdded  17
iter2 FAST   72 -> 72   tracksAdded   4
iter3 强轮   72 ->  6   tracksAdded 186   delta -66   ← 目前最好
iter4 强轮    6 -> 105  tracksAdded  12   delta +99   ← 15 倍恶化
iter5 强轮  105 -> 20   tracksAdded   1   delta -85
```

**更关键的一半。** 4 轮（`iter<4`）与 6 轮跑出来的 DRC **完全一样**：`drcLeafCount 33` /
`drcTotalCount 66`，`byType` 逐格相同 —— `Slot Region to Track 10`、`SMD Pad to Track 7`、
`Connection Error | SMD Pad 6`、`Track to Track 4`、`Hole to Hole 3`、
`Connection Error | Track 2`、`SMD Pad to Via 1`。

两次运行的断连数分别是 6 和 20（另一次同设计运行是 181），DRC 直方图一格没变。
**所以这 33 个叶子不是布线质量的函数**，它是布局与几何决定的。这个结论直接改变了主攻方向：
再调布线参数不会动它。

**已修。** `MAX_ROUTE_ITERS` 回到 4（只给一次强轮）；四道预算闸
（`left() < 240000` / `capRaw < capNeed` / `tracksAddedThisIter === 0` / `stillUnconnected === 0`）
全部保留。另加 `routeRegressed` 一条日志：强轮把断连推高时单列，带倍率。
此前要人把若干条 `routeIter` 摆在一起心算才看得出拐点，而这个上限该写几完全取决于拐点在哪。

**顺带承认一件事。** 这条结论的一半证据（4 轮那次的 `byType`）**已经在磁盘上没了** ——
原因见第 25 条。本文引用它时只能写「2026-11-26T16:50 现场读数」，不能指向某个可复查的文件。

### 23. `patchDrc` 两轮两败

**实测。** 两次运行，`patchVerify` 都是「改完更差」：

| 运行 | before | after | 处置 |
|---|---|---|---|
| 162010 | 62 | 84 | 撤回（`deleted 12 / total 12`） |
| 163653 attempt 1 | 33 | 56 | 撤回（`deleted 10 / restored 5 / viaRestored 1`） |

`patchReverted` 的 `why` 字段自己写着「这一轮把板子改断了（Connection Error 变多）—— 断路比间距违规严重，整轮撤回」，
`patchTotal` 两次都是 0。也就是说这个阶段花掉 19.7 s，**产出是负的**，而它自己知道，也有能力撤回。

**这一条的性质。** 它不是"补丁写得不好"，是"补丁这个动作在这块板上不成立"：
板子已经紧到没有挪动空间，任何局部挪动都会撞出新断路。所以它必须**先证明能改善再落地**，
而不是"先改再验、验不好再回滚"—— 回滚把 19.7 s 和一次重铺铜的扰动都留在了板上。

### 24. `doc-refs` 只判「引用的那一行非空」

**实测。** 我在 `run-all.ps1` 里插了 70 行（`body` 全部下移），`doc-refs` 照样
`DOCREFS=PASS 发布文档 58 处引用有效`。因为它只检查被引用行**不是空行**。
而同一轮里 `scripts/pipeline3.js` 的插入把 `docs/FAILURES.md` 引用的 `:2139`
顶成了一行空白，它才终于变红。

**后果（实测的三个例子）。** 改前正文说 `L833` 是
`eda.pcb_PrimitiveRegion.create(12, spoly, [5, 7], ...)` —— 实测在 **L1085**；
说 `L875` 是 `if (slotKeepout.found === 0)` —— 实测 **L1127**；
说 `L2456` 是 `log('slotHoleUsed')` —— 实测 **L2897**。
三处都指到了别的代码，而闸门全绿。

**为什么这比"红"更糟。** 一个红的闸门会被人修；一个只在恰好落到空行时才红的闸门，
会让所有引用悄悄烂掉，而每个读文档的人都以为它被校验过。

**已改。** 第 9 条的位置列从行号改成**事件名/函数名**
（`slotKeepout` / `slotPadGeometry` / `ensureGeoIdx` / `slotHoleUsed` / `noSideIsViaOrTrack`），
正文行号按当前文件重新核对。这也正是 AGENTS.md 说的「闸门只锚在稳定子串上」。

**还没做的。** 闸门本身没变强。真正的修法是让 `doc-refs` 支持
`file:line#<必须出现的子串>` 形式，两者同时成立才算引用有效。这条留给后面。

### 25. 遥测改名只在成功路径上，失败那一轮的证据被下一轮覆盖

**现象。** `out/ESP32S3_Wireless_Mic_V3-20261126-163653/` 里只有
`_run.json` / `_log.json`，**没有** `_run-1-smart-fit.json` 之类的分轮副本。
而 `run-all.ps1` 的改名块本该把每一轮的遥测落成 `_run-<idx>-<tag>.json`。

**根因。** 改名块在 `ConvertFrom-Json` **成功之后**的路径上。第 21 条那个缺陷让第一轮
解析失败并 `continue`，于是改名没执行；第二轮把同名 `_run.json` / `_log.json` 直接覆盖。
`New-Item -Force` + 同名写入，不报错、不提示，**上一轮的测量结果就此消失**。

**后果（就是我这次踩到的）。** 第 22 条要比较"4 轮"和"6 轮"的 `byType`，
而 4 轮那份已经不存在了；第 21 条要引用那次 781.5 s 构建的 `pathNeeded` 清单，
也只能靠现场读数。**一次失败会连带销毁它自己的证据**，这正是最难复盘的那种组合。

**该怎么修。** 改名（以及任何"留存本轮遥测"的动作）放进 `finally`，
而不是放在成功分支里。名字里已经带了轮次和 tag，所以同名覆盖本来就不该发生。


## 七、2026-11-26 傍晚新测出来的两条（重试阶梯与几何索引）

### 26. 器件坐标被钉死时，扩板重试是可证明的 no-op

**现象。** `run-all.ps1` 的重试阶梯第二级是 `expand-1.25x`：把板框从 `W×H` 放大到
`W×1.25 × H×1.25`，期望「地方大了，布线和间距都会好转」。在 `mic-esp32s3-v3` 上，
**放大 56% 面积换来的 DRC 直方图与上一级逐位相同**：

| 尝试 | 板框 | 面积（mil²） | DRC 叶子 | 直方图 |
|---|---|---|---|---|
| `smart-fit` | 1300×3700 | 4 810 000 | **32** | 见下 |
| `expand-1.25x` | 1625×4625 | 7 515 625 | **32** | **逐位相同** |
| `expand-1.25x-retry` | 1625×4625 | 7 515 625 | **32** | **逐位相同** |

三次尝试、两种板宽、面积差 56%、布线轮次不同（`routeIter` 分别是 3 轮 / 3 轮 / 3 轮），
**直方图一个字都没变**。这比「两次相同」强得多：布线器本身不是确定性的
（见 `inbox\2026-11-26-布线不是确定性的.md`），它三次却给出同一份 32 条，
说明这 32 条根本不经过布线器 —— 它们是**固定几何**。

两份直方图（`_log-1-smart-fit.json` 与 `_log-2-expand-1.25x.json` 的 `drcLeaves.byType`）：

```
Track to Track 4 · SMD Pad to Track 7 · SMD Pad to Via 1 · Slot Region to Track 9
Hole to Hole 3 · Connection Error | Track 2 · Connection Error | SMD Pad 6
```

七类、三十二项、一项不差。

**根因。** 这个设计的每一个器件坐标都写在 `_placement` 里（`U1.y = -3316`、`USB1 = (234,-2560,90)` …），
`outlineFit` 走的是 `explicitFixed` 分支，只把**板框**放大，**器件一个都不动**。
而 32 条违规全部由器件的相对几何产生（见下表的四簇），板框变大不改变任何一条。

**这 32 条落在哪里（按违规点最近的器件聚类）。**

| 簇 | 违规点范围 | 条数 | 最近器件 | 特征 |
|---|---|---|---|---|
| A | x 133–187，y −2389…−2730 | 8 | `USB1` | USB-C 壳体长圆孔（4 条 GND 槽，`d=31.496`、`len=59.055/47.244`） |
| B | x 380–399，y −1647…−1710 | 9 | `U5` | 走线与焊盘**全部 `cur=0`** —— 这是真短路，不是「差一点」 |
| C | x 634–650，y −228…−231 | 6 | `U4` | 全部挂在同一个 17×17 mil 对象上（见第 27 条） |
| D | x 328，y −1529 | 1 | `U3` | Hole to Hole，`cur=0` |

**为什么这条重要。** 第 11、16、17、22 条已经分别从「收缩转移」「变体覆盖」「作业自报 state」
「强轮上限」四个角度证明重试阶梯不划算；这一条补上的是**第五个、也是最强的一个角度**：
当布局被固定时，扩大板框在**几何上**不可能改变任何一条违规，所以那 380 秒是纯损耗。
「再试一次会更好」在这里不是经验判断，是**可证伪且已被证伪**的。

**怎么复现。** 同一个 `OutDir` 下比 `_run-1-smart-fit.json` 与 `_run-2-expand-1.25x.json` 的
`gates.drcLeafCount`，再比两份 `_log-*.json` 里 `drcLeaves.byType` 的键与值。

### 27. `ensureGeoIdx` 漏了 pour / poured，`resolveByOwner` 的 pour 分支永远不可达

**现象。** 几何索引一次运行后自报的规模是：

```json
{"pad":159,"line":455,"via":93,"region":1,"polyline":1,"fill":0}
```

而同一轮 `_run.json` 里 `pouredCount = 2`（`pcb_PrimitivePoured.getAllPrimitiveId()` 真返回 2 条）。
**板上有 2 块实铜，几何索引里一块都没有。**

**根因。** `resolveByOwner` 的条件里**已经**写着 `owner === 'pour'`，三元链也**已经**把它
映射到 `eda.pcb_PrimitivePour`。缺的只是 `ensureGeoIdx` 的 `sets` 里从来没有 `pour` 这个集合，
也从来没有 `await load('pour', eda.pcb_PrimitivePour)`。于是「一个写好的分支」配「一个永远为空的集合」，
等于**一行死代码 —— 而它读起来是对的**。这类缺陷比写错难发现得多：代码审查时会略过，
因为那个分支看起来处理过了。

同一个错误假设还造成了第二处死机制：`slotKeepout`（建槽孔禁布区那段）查的是
`pcb_PrimitiveFill.getAllPrimitiveId(12)`，而 **Fill 与 Pour 不是同一个东西** ——
实测 `fillCensus` 在 `L∈{1,2,12,15,16,17}` 上**全部为 0**。
所以那段代码的 `found` 永远等于 0，它报的 `found:0` 从来不是「板上没槽」，
而是「查错了类」。四处真实存在的 GND 长圆槽（`holeTypes: {ROUND: 8, SLOT: 4}`）
是在**后面那段按焊盘普查**的代码里才被找到的。

**后果。** 32 条 DRC 叶子里有 6 条（上表 C 簇）挂在同一个 17×17 mil 的对象上：
`bbox [642,-240,658,-223]`、中心 `(650,-231)`，`parentOwners` 恒为 `[]`。
它既不是 pad、不是 line、不是 via、不是 region、不是 polyline、也不是 fill，
于是走「无主」的合成盒分支，用 100×99 的**假盒子**去算绕行位置 ——
而它的真实形状既不是那个盒子、也不是 17×17。绕行位置自然不对，那 6 条也就绕着它转圈。

**代码位置。** `scripts/pipeline3.js` 的 `ensureGeoIdx`（`sets` 与 `load` 这两处）
与 `resolveByOwner`（条件与三元链）。

**怎么复现。** `_log-1-smart-fit.json` 里 `slotGeoCmp[].idxSizes` 没有 `pour` 键；
同文件 `pouredCount` 为 2。

**该怎么修。** 索引里同时放进 `pour` 与 `poured`，并把 `poured` 也接进 `resolveByOwner`
的三元链 —— 只补 `pour` 会留下另一半。补完之后 `parentOwners` 才能区分
「不在任何索引里」和「在索引里但取不到几何」这两种完全不同的情况。
## 八、2026-11-26 深夜新测出来的一条（EP 地孔的尺寸闸门）

### 30. `preVia` 的「被包围 GND 焊盘」判据不问焊盘尺寸，在 0.5mm 间距引脚上打了 19.7 mil 的孔

**现象。** 一次完整构建（`out/ESP32S3_Wireless_Mic_V5-20261126-203952`，`_run.json.elapsedMs=613416`，
测于 2026-11-26T20:50:22+08:00）的 DRC 报了 4 条 `Clearance Error | SMD Pad to Via`，`cur` 全是 **0**：

| 坐标（mil） | 报的类型 | cur | need |
|---|---|---|---|
| (625, −2041) | SMD Pad to Via | **0** | 6 |
| (591, −2095) | SMD Pad to Via | **0** | 6 |
| (729, −1744) | SMD Pad to Via | **0** | 6 |
| (729, −1676) | SMD Pad to Via | **0** | 6 |

`cur=0` 不是「间距差一点」，是**两块铜直接相接**。同一次运行的日志里 `epViaAt` 一共 9 条，
其中 4 条的焊盘坐标与上面这 4 条**逐点对上**，而它们的 `near`（到最近非 GND 焊盘的距离）全部落在
**19.4~25.6 mil**。

**根因。** 判据是这一行：

```js
if ((hasUp && hasDown) || (hasLeft && hasRight)) enclosed.push(g);
```

它只回答「上下（或左右）十五 mil 之外有没有别的焊盘」，**完全不问焊盘自己有多大**。
U3 是 MAX98357A、0.5mm 间距，相邻盘心正好 **19.7 mil**，所以那一排的**中间引脚天然左右都有邻居**，
一律被判成「被本体包围的 EP 焊盘」。而被判中的那些焊盘，实测包围盒只有 **10×24 / 24×10 mil**
（`getPrimitivesBBox` 逐盘读数）——比要打的孔外径 **19.7 mil 还窄**。
孔比焊盘宽，必然压到相邻引脚的铜。

**换句判断。** 这不是「间距余量不够」，是「**孔画在了装不下它的焊盘上**」。
0.3mm 的孔配 0.5mm 的间距，在任何工艺下都不成立；问题不在布线，在打孔前没量尺寸。

**该怎么修（已落地）。** 打孔前先用 `getPrimitivesBBox` 实测焊盘，要求两个方向都
装得下「孔外径 + 两侧各一份间距」：

```
EP_VIA_NEED = EP_VIA_D(19.7) + 2 * EP_VIA_CLEAR(6) = 31.7 mil
```

（6 mil 不是拍的：取自本板 DRC 实测的 `SMD Pad to Via need=6`。）

装不下就**不打**，读不到包围盒也**不打**（盲打正是这次短路的成因），两种都留一条 `epViaSkip` 账，
`why` 分别是 `padTooSmall` / `noBBox`。同时把 `epVias` 的读数改成带分母：

```json
{"count": <真建出来的孔数>, "candidates": <判据挑中的数量>, "skipped": <跳过数>,
 "skipBy": {"padTooSmall": n, "noBBox": m}, "note": "candidates = count + skipped"}
```

`count` 的语义与改前保持一致（仍是「真的建出来的孔数」），新增的三个字段把分母补上 ——
否则「0 个地孔」读不出是「没有候选」还是「候选全被闸门拦了」。

**闸门。** `test/epvia-size-gate.mjs`，30 条断言 / 6 场景，抽的是文件里**真实落地的那段代码**
加桩依赖跑：拦小盘 · 拦无盒 · **放行大盘（positive control）** · 边界方向（31.7 放行 / 31.69 拦）·
混合记账 · 空集零代价。第三、四条是必需的：只有「拦」的断言时，一个**永远返回 false** 的闸门
也能全绿，那等于把短路换成「GND 一个地孔都没有」——同样是缺陷，只是更难发现。

**双向证明（已做）。** 四个方向各自注入破坏，全部变红，逐字节还原后复绿：

| 变异 | 破坏内容 | 结果 |
|---|---|---|
| M1 | 拿掉尺寸闸门（退回盲打孔） | exit 1，**12 条**断言失败（`[small]` 6 条 + `[nobbox]` 6 条） |
| M2 | 闸门永远拦住（连 60×60 大盘也不打） | exit 1，**11 条**失败（`[big]` / `[edge]` / `[mixed]`） |
| M3 | 分母造假（`skipped` 恒 0） | exit 1，**5 条**失败（全是分母闭合断言） |
| M4 | 边界写反（`<=` 代替 `<`） | exit 1，**1 条**失败（`[edge] 31.7 恰好放行`） |

四轮还原后 `sha256_12` 均为 `E433D662DA70`，403 B 级差 0。

**为什么这条值得单独写。** 它和这个文件里大多数条目的方向相反：那些是「流水线报了个好看的数，
其实没测」，这条是「流水线在没人看的时候**主动造了一个缺陷**」。
地孔自动补全是纯增益动作，没人会去核对它，而它的失败形态是短路而不是断路 ——
不报错、DRC 也只是若干条 `Clearance`，很容易被当成「间距余量」放过去。

**顺带记一个否定结果。** 同一次运行还有一处 3V3↔GND 真短路 `(479, −304)`，
`clearNet` 里 `sameNet:false / cur:0`，与这条**无关**（那是布线器画的走线，不是地孔），
截至本条仍未修。
