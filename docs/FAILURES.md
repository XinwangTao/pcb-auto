# 已知缺陷与自查记录

这份文档记录本项目自己审计出来的缺陷，也记录审计过程中**被证伪**的说法。一个声称「可信」的流水线，如果只公布通过率，读的人分不清它是真测过，还是只挑了好样本。把错的也写出来，别人才有得核对。

每条都标了核实状态：**真**（结论与代码、语料一致）、**部分真**（成立的那一半与不成立的那一半分开写）、**假**（当初的怀疑不成立）。每条给出代码位置（`文件:行号`）、在 `out\` 语料里观测到的数字，以及一句自己能重跑的核对命令。

**以下结论均为 2026-11-26 对仓库内代码与 `out\` 语料的核对结果，语料会变，所以每条都给了自己能重跑的定位信息。**

## 结论速览

| 编号 | 结论 | 一句话 | 位置 |
|---|---|---|---|
| 1 | 部分真 | `skippedNoAnchor` 字段真实存在且语料全 0，但其中一条自增分支静态不可达 | `scripts/pipeline3.js:1651,1686,1697,1731` |
| 2 | 真 | 补线阶段 5 处丢弃点，只有一处连日志都没有；真正大量丢的是 80mil 上限那条 | `scripts/pipeline3.js:3724-3726,3764,3840` |
| 3 | 真 | 缝合失败只记一句异常字符串，37 次全是同一句，不带网/坐标/id | `scripts/pipeline3.js:1702-1727` |
| 4 | 真 | `fixed` 数的是「变更 API 接受了」，不是「违规真的减少了」 | `scripts/pipeline3.js:3434,3445-3456` |
| 5 | 部分真 | 逐级收窄是真的；但它不是「白名单」，白名单这个词在代码里不存在 | `scripts/pipeline3.js:3594,3726,3757,3773,3840` |
| 6 | 假 | 负 Y / 某个负坐标不是坐标系符号错；那条坐标是测试夹具字面 | `scripts/pipeline3.js:729-733` |
| 7 | 真 | `coverage` 算完只进日志，此后无人读取，「过孔盘覆盖不足」假设没接过任何动作 | `scripts/pipeline3.js:3823-3838` |
| 8 | 真 | `rulesApplied` 只有一处赋值、不进 `_run.json`、不参与判定；136 次里 30 次为 false | `scripts/pipeline3.js:1339,1344` |
| 9 | 假 | Slot Region 有处理分支（4 处）；没有认领者的是另外两类违规 | `scripts/pipeline3.js:797-966,2139-2156,2456,3097-3100` |
| 10 | 真 | `_run.json` 写的是布局前的声明板框，扩板后从不回写 | `scripts/pipeline3.js:663,716-795,4468,4524`；`scripts/fabcheck.js:444-448` |
| 11 | 部分真 | 重试阶梯里确实有预缩机制；但语料里 0 次收缩转移，收缩只发生在第一轮之前 | `run-all.ps1:508-518,536,554,561,569` |
| 12 | 真 | 流水线不查图元绝对坐标出框，真正的判定在离线校验器里 | `scripts/pipeline3.js:713-737`；`scripts/fabcheck.js:415,463-468` |
| 13 | 真 | README 生成脚本用动态值算目录数，却把「两目录」写死在散文里 | `out/_probe/sync-readme-numbers.py:153-156`；`交付-README.md:44-45` |
| 14 | 真 | `fabcheck` 四类结果都以 `id` 为第一键同台输出，正则数 `"id"` 会把阻断数放大 | `scripts/fabcheck.js:312-319,764-771,781-784` |
| 15 | 真 | `_run.json.ok` 与「可下单」不是同一批：48 相等是巧合，集合不同 | `out/_probe/fab-census.json`；`scripts/fabcheck.js:764-771` |

**统计口径。** 15 条：**10 真 / 3 部分真 / 2 假 / 0 未证实**。

语料规模：`out\` 下 **56 个含 `_run.json` 的目录**，其中 **53 个可下单**、3 个有阻断、0 个解析失败。来源是快照 `out\_probe\fab-census.json`，**测于该文件的 `measured_at` 字段**（引用时直接读它，不要读 mtime —— 理由见下一段。这里故意不写「第 N 行」：那种引用会在任何一次插入后指错地方）。

**为什么不能拿 mtime 当时点。** mtime 是文件系统的属性，不是测量的属性：任何人 `git clone` 之后，仓库里每个文件的 mtime 都等于**克隆时刻**。所以「测于 `<文件>` 的 mtime」这句话对**每一个读者**都是错的，而他没有任何办法从仓库里看出真实时点。时点放进了 JSON 的 `measured_at` 字段，字段跟着 blob 走，克隆、拷贝、checkout 都不会改它。

这些数字有时点。`out\` 会被清理脚本按「保留最新 40 个目录 + 每个设计名最新 1 份」滚动裁剪（`scripts/cleanup.ps1:19`），所以任何「N 个目录里 M 个…」都会随时间和清理动作变化；引用时必须带时点与分母，否则下次复算对不上。

## 一、已证实的缺陷（真）

### 2. 补线阶段的丢弃路径：只有一处连日志都没有

**现象。** 兜底补线循环（`for (const v of connErrs)`，`3714` 起、`3894` 收）里一共 **7 处 `continue`**。每一处都意味着「这条断连本轮不再往下走」。注意：其中一部分是**已经动过板**才收尾的（`3814` 跨层分支真的打了过孔），另一部分是真的什么都没做。

**代码位置。** 典型的那一处 `scripts/pipeline3.js:3724-3726`：

```js
const edPos = ed.position;
const pos = edPos ? { x: Number(edPos.x) * 10, y: Number(edPos.y) * 10 } : v.pos;
if (!net || !pos) { log('patchNoNet', { err: String(ed.globalIndex || ''), obj1: String(ed.obj1 || '') }); continue; }
```

**全部 7 处丢弃点。** 语料：`out\*\_log*.json` 共 **136** 个文件（分母）。

| 行 | 条件 | 日志名 | 语料次数 |
|---|---|---|---|
| `pipeline3.js:3726` | 拿不到网名或位置 | `patchNoNet` | **0** |
| `pipeline3.js:3761` | 两个图元查不到几何 | `patchNoGeo` | **0** |
| `pipeline3.js:3764` | `closestPair` 返回空或距离非有限 | **没有日志** | **无法计数** |
| `pipeline3.js:3814` | 跨层分支收尾（打孔成功记 `patchedCrossLayer`、失败记 `patchCrossLayerNoObj`） | 两条都有 | **0 / 0** |
| `pipeline3.js:3838` | 两对象已贴合仍不连通（跨层时先试过打孔） | `patchIslandPair` | **1** |
| `pipeline3.js:3842` | `cp.d > 80`（80mil 上限） | `patchTooFar` | **653** |
| `pipeline3.js:3881` | `create` 之后一个 id 都没拿到（已回滚） | `patchNoObj` | **0** |

**真正的问题在哪一行。** 不是最容易被注意到的 L3726，而是 **L3764**：

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

**代码位置。** `scripts/pipeline3.js:1702-1727`。try 块里唯一的 API 调用是 L1703 的 `eda.pcb_PrimitiveLine.create(...)`；L1710 已经有 `m?.getState_PrimitiveId?.()` 保护——代码是**读返回值**判断失败的，不是靠异常；L1727 的 catch 只有 `log('stitchErr', String(e && e.message).slice(0, 120))`。

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

**代码位置。** `scripts/pipeline3.js:3434` 落盘 `{ round, violations: clears.length, fixed }`；L3445-3447 的注释原文：

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

**代码位置。** `scripts/pipeline3.js:3823-3838`：L3823 `let coverage = null` → L3826-3832 算 `r = dia/2`、`dEnd`（末端到孔心的最小距离）、`covered` → L3834-3836 把 `coverage` 放进 `log('patchIslandPair', ...)` → L3838 `continue`。全文 `coverage` 只有三处代码引用（L3823 赋值、L3831 构造、L3836 落日志），都在同一个块内，没有第四处读取。

**语料里观测到什么。** `patchIslandPair` 仅 **1** 条，且带 `coverage` 字段。

**影响。** 「过孔盘覆盖不足」这个假设至今**没有被任何动作或闸门使用过**。它现在的作用只是让日志里多一个字段；把它读成「已经处理了覆盖问题」是错的。这一条与第 2 条同源：观测到的量不进入判定，判定就不会因为它改变。

**怎么自己核对。**

```bash
grep -n "coverage" scripts/pipeline3.js        # 代码只有 3823 / 3831 / 3836，另有一处注释 1406
grep -o '"patchIslandPair"' out/*/_log*.json | wc -l   # 1
```

### 8. `rulesApplied` 只是一个尺寸命中判断，不进 `_run.json`、不参与判定

**现象。** 日志里有一条 `routeRulesProof`，带 `rulesApplied: true/false`，读起来像「走线规则生效了没有」。它其实只是「成品过孔里有没有一对尺寸等于我们指定的 h/d」。

**代码位置。** `scripts/pipeline3.js:1339` `const specHit = pairs.some(...)`；L1344 `rulesApplied: specHit`。全文件只有这一处赋值，没有分支、没有后续改写。

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
**代码位置。** `scripts/pipeline3.js:730-733`：注释明确「不用绝对坐标比较」，判据是 `spanW <= bw0-40 && spanH <= bh0-40`（器件跨度 vs 板框尺寸）。L742-795 只处理「装不下 → 删旧板框、等比扩板」。全文 grep `outside` 只命中 L3097-3100 一个语义无关的走廊变量名。

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

一个干净目录的直接读数（`scripts/fabcheck.js out/AI_RP2040_系统-20261125-033939`）：`blockers` 长度 **0**、`warnings` **4**、`notes` **5**、`passes` **11**——14 个非阻断结果都带 `id`，而阻断数是 0。所以「数 `"id"` 会把阻断数放大」不是夸张：分母是 0 时这个比率根本不存在，只能按结构说它会把「十几条 pass/note/warn」算成「十几条阻断」。审计记录给的整体倍数是 **~19 倍**——**那是推算，没有实跑复算**。

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

## 二、部分成立（部分真）

### 1. `skippedNoAnchor` 全为 0：字段是真的，「健康」是半结构性的

**成立的那一半。** 字段真实存在并被写进日志：`scripts/pipeline3.js:1651` 声明 `let skipNoAnchor = 0, skipTooFar = 0`，L1686 在「断点离同层锚点超过 12mil」时自增，L1731 随 `stitchRound` 一起落盘。审计表里 **66 轮** `stitchRound` 的 `skippedNoAnchor` 全为 0。按同一判据在 2026-11-26 11:1x 对当前 56 个含 `_run.json` 的目录重跑一次（`--settle 180` 无关，这里是读盘统计），是 **78 轮、非零 0 次**——轮数变是因为语料被滚动过，结论同一个：一次都没触发过。

**不成立的那一半。** 把这个 0 读成「找不到锚点这条路径被健康覆盖」不成立。L1697 的 `else skipNoAnchor++` 分支**在静态上恒不可达**：

```js
if (!other || otherD > MAX_GAP) { if (other) skipTooFar++; else skipNoAnchor++; continue; }
```

`other` 来自非空 `islands`；而 L1674 `if (pool.length < 2) continue`、L1676 `if (islands.length < 2) continue` 已经保证 `islands` 至少 2 个岛。遍历除 `myIsland` 以外的岛时，`other` 必然被赋值，所以 `!other` 永远为假，`else` 永远走不到。能自增 `skipNoAnchor` 的只剩 L1686。

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

- `scripts/pipeline3.js:3594`：只认 `errorType === 'Connection Error'`；
- L3726：还要有 `net` 与 `pos`；
- L3757：还要 `o1`/`o2` 两个对象几何都取得到，否则 `patchNoGeo`；
- L3773：`cp.d <= 1.0` 落入「孤岛/跨层」分支（跨层先打过孔，否则记 `patchIslandPair`）；
- L3840：`cp.d > 80` 放弃，记 `patchTooFar`（已吞 653 条）。

**不成立的那一半。** 「白名单 / allowlist / whitelist」这些词在 `pipeline3.js` 里**一次都搜不到**。它不是一个可列举的名单，而是「叶子形状 + id 可解 + 间距区间」的复合条件——每一道门都是对**对象**的判断，不是对**类型名**的查表。

**影响。** 写成「白名单」会让维护者以为改个数组就能放开某类断点，实际上要改的是几何可解性与间距阈值。措辞会把人引到错误的位置。

**怎么自己核对。**

```bash
grep -n "whitelist\|allowlist\|白名单" scripts/pipeline3.js   # 0 命中
sed -n '3590,3600p;3720,3730p;3750,3760p;3770,3780p;3835,3845p' scripts/pipeline3.js
```

### 11. 重试阶梯：机制上有预缩，语料里 0 次收缩

**成立的那一半。** 「重试阶梯能把板改小」有代码支撑。`run-all.ps1:508-510` 是**预缩**分支：`if ($baseArea -gt [Math]::Max($estArea * 2.2, $FIVExFIVE_MIL2)) { $baseW = [int]($estSide * 1.15); ... }`。L511-518 才是放大。阶梯本身在 L536/554/561/569：smart-fit 之后三档 `expand-1.25x / retry / retry2` 尺寸相同，只差 tag。

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

**实际是什么。** 负 Y 是布局产物的正常形态。`scripts/pipeline3.js:729-730` 的注释原文：

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

**实际是什么。** 至少有四条独立路径在处理 Slot Region：

- `scripts/pipeline3.js:797-966`：把 MULTI(12) 的填充罩成禁布区——L833 `eda.pcb_PrimitiveRegion.create(12, spoly, [5, 7], ...)`，并在 L810 `found/created/failed/skippedBig/areas` 上做普查；L875 的 `if (slotKeepout.found === 0)` 专门区分「板上真没有槽」与「查错了层/类型」；
- L2112-2117 按 owner 选类（`region` / `polyline` / `fill` / `pour`）再 `get(id)`，L2139-2156 按类试 `getState_ComplexPolygon` / `getState_Polygon` 访问器、`getSource()` 兜底，轮廓用 `discretize()`（L1998-2001）取点；
- L2456：`log('slotHoleUsed')`——用真槽孔几何（`getState_Hole()` 的 SLOT）替代与槽孔无关的外接盒；
- L3097-3100：把障碍物外侧当绕行走廊的必要条件；L3105-3108 的注释写明「Via/Hole 扣半径；Slot Region/Pad 按轮廓算」；而把障碍类型落盘的是 L3400-3410 的 `log('trackRerouted', {... obstacleType, objId, obsSrc ...})`。

语料 `trackRerouted` 里 `obstacleType:"Slot Region"` 出现 **22 次**——它确实作为障碍物被处理过。

**准确的表述。** Slot Region **作为障碍物已处理**。**作为被违规对象时**，有一角确实没有认领者：`clearanceNoHandler.uncovered` 里出现过 `SMD Pad×Slot Region` 与 `Hole×Slot Region`（当前语料里各见到 `n=1` 的一轮），两侧都不是 Via/Track——L2674-2677 的 `noSideIsViaOrTrack` 正是判据，所以两个修复环都不认领。而 `Slot Region to Track` 是 **covered** 的：`drcLeaves.byType` 的键写作 `Clearance Error | Slot Region to Track`，当前语料共 **25** 条；它有一侧是 Track，Track 环会认领。

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

仓里真正的闸门有两处，都按「包装后的函数体」解析：`run-all.ps1:59-72`（`new (require('vm').Script)('(async function(){' + s + '\n})')`，不通过就回退上一次验证过的备份），以及全仓闸门 `test/syntax-gate.mjs`。后者在 `test/syntax-gate.mjs:10-12` 记了一张对照表：受跟踪 `.js` 186 个、`node --check` 失败 92 个（≥49%）、按真实形式解析失败 0 个。

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
