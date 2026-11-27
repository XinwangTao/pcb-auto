# 最后 2 条 DRC 叶子：不是「没有可动的孔」，是**拿画布单位的点去和 mil 单位的孔算距离**

> 记录时间：2026-11-26 22:1x–22:4x（Asia/Shanghai）
> 样本：`out/ESP32S3_Wireless_Mic_V5-20261126-214236`（attempt 1 / smart-fit，`elapsedMs=513773`，
> `drcLeafCount={passed:false, leaves:2, total:4}`，`fabcheck` exit 0 / 0 阻断）
> 结论：这 2 条 `Hole to Hole` 本来有处理器，处理器**每一轮都被自己的单位错误挡在门外**。
> 修掉之后仍要跑一遍才算数 —— 本文件第六节给出验收条件，**在跑出来之前不当结论**。

## 一、这 2 条叶子是什么

`drcLeaves.sample` 两条，`byType = {"Clearance Error | Hole to Hole": 2}`，`cur=8 need=12`，
位置 `(99,−390)` 与 `(99,−49)` mil。解析 `Gerber.zip → Drill_PTH_Through.DRL` 后实测：

| 对象 | 位置（mil） | 直径 | 边到边 |
|---|---|---|---|
| 电镀孔 | `(88.95, −389.32)` | **12.01 mil**（0.305 mm） | — |
| 屏蔽长圆槽 | 中心线 `(119.07,−390.27)–(146.63,−390.27)` | **31.50 mil**（0.8 mm），槽长 59.06 | **8.38 mil** |

`8.38` 与 DRC 报的 `cur=8` 吻合；`need=12` 就是 0.305 mm 的孔到孔规则。
另一条 `(99,−49)` 结构完全对称。

## 二、先定死「那个孔是我们打的过孔，还是器件自己的脚」

三个钻带文件逐个工具计数：

| 文件 | T01 0.30mm | T02 0.305mm | T03 0.80mm | T04 0.90mm | 合计 |
|---|---|---|---|---|---|
| `Drill_PTH_Through.DRL` | 1 | 100 | **4（G85 槽）** | 2 | 107 |
| `Drill_PTH_Through_Via.DRL` | 1 | 100 | 0 | 0 | **101** |
| `Drill_NPTH_Through.DRL` | 2（0.60mm） | — | — | — | 2 |

- `101 + 107 + 2 = 210` = fabcheck 报的「声明 **210** 孔」；
- 唯一孔数 `101 + 4 + 2 + 2 = 109` = fabcheck 报的「唯一 **109** 孔」。
  **两条独立算术都精确对上，所以 `Drill_PTH_Through_Via.DRL` 就是那 101 个过孔，
  而 `Drill_PTH_Through.DRL` 是它的超集**（含 4 槽 + 2 个 0.9mm 孔）。
- 那 2 个 12.01 mil 孔在 Via 文件里 ⇒ 是过孔。旁证：`viaShrunk` 记录过一次
  `[12,24] → [11.8,19.7]`，说明过孔默认就是 `hole 12 / dia 24`，
  T02 = 12.01 mil 正是**没被缩过**的默认孔径（101 个里 100 个都是它）。
- 也排除了「是某个器件焊盘孔」：`padsBeforeVia` 的 163 个焊盘里，没有一个落在
  这两个坐标 3 mil 之内（实测 0 命中）。

## 三、处理器存在，而且**意图是对的**

`scripts/pipeline3.js` 的 `holePairs` 分支（`patchNoNet` 那条循环里）专门处理
`obj1Type === 'Hole' && obj2Type === 'Hole'`：找最近的过孔、把它沿
「从违规点指向该孔」的方向推 `delta` mil。对「孔到孔间距不足」而言，
**推开其中一个孔就是正解** —— 加铜、缩焊盘都改不了两个既有孔的相对位置。

`delta` 的算法也对：`deficit = need − cur = 12 − 8 = 4`，`delta = ceil(4+1) = 5`，
上限 6，`deficit+1 > 6` 才放弃。5 mil 完全够把 8.38 补到 13.38。

## 四、那它为什么一次都没修过

`holePairNudged` 在整份语料里**一次都没出现过**；每次都是
`holePairSummary {total: 2, fixed: 0}` 配 `holePairNoVia {near: 79.64 / 90.39}`。

根因是**两套坐标单位混算**：

| 量 | 单位 | 实测值 |
|---|---|---|
| `explanation.errData.position.x/y` | **画布单位 = mil/10** | `9.914 / −38.964` |
| `pcb_PrimitiveVia.getState_X/Y` | **mil** | `88.95 / −389.32` |

两条独立的量都能对上这个判定：

1. `position × 10 = (99.14, −389.64)`，与 DRC 叶子的 `(99,−390)` 是同一个点；
2. 同一份 `errData` 里 `clearance=1.2`、`minDistance=0.8`，经代码里已有的
   `holeNumMil()`（×10）变成 `need=12 / cur=8`，与钻孔实测 8.38 mil 吻合。

也就是说**同一个 `errData` 对象里，`clearance`/`minDistance` 被正确 ×10 了，
`position` 没有**。而后面 `d = Math.hypot(g.x − ax, g.y − ay)` 直接拿 mil 的
`g.x/g.y` 减画布单位的 `ax/ay`，`d` 恒在 350 量级（主要是 y 差：
`−389` 对 `−38.96`），永远过不了 `best.d <= 40`。

于是每一轮都走进 `holePairNoVia` 并记下 `near: 79.64` —— 一个既不是 mil 也不是
画布单位的数。「最近的地孔在 79 mil 之外」这个读数**是算出来的垃圾**，
它读起来却完全像一个实测结论。

修法：`const ax = Number(p.x) * 10, ay = Number(p.y) * 10;`（`pipeline3.js`
`sha 75739C18B5DD → A15E87A17C37`，+1055 B，`staticcheck` exit 0、
`syntax-gate` exit 0）。修后 `d = 10.2` ⇒ 过门 ⇒ `delta = 5` ⇒ 推离槽 5 mil。

## 五、为什么不能用禁布区从源头拦掉

自然而然的替代方案是「在槽周围罩一圈禁布区，让布线器别在那儿打过孔」。
**当前 API 表达不了这个。** `EPCB_PrimitiveRegionRuleType` 的**全部**取值
（`api-types.d.ts` L19519–19526，0.3.86.fb57d12b）：

```
NO_COMPONENTS = 2   NO_WIRES = 5   NO_FILLS = 6
NO_POURS = 7        NO_INNER_ELECTRICAL_LAYERS = 8   FOLLOW_REGION_RULE = 9
```

**没有「禁止过孔」这一档。** 用 `NO_WIRES` 会连壳脚必须进焊盘的走线一起堵掉
（这正是 `slotKeepout` 当初「只普查不建禁布区」的理由，见该段注释 L1287–1289）。
把这个枚举抄进代码注释，比留一句「加个禁布区就好了」有用。

## 六、修完的实测读数（2026-11-26 22:2x，`out/ESP32S3_Wireless_Mic_V5-20261126-222113`）

验收条件是在跑之前写下的，下面是跑出来的：

| 条件 | 结果 |
|---|---|
| `copperVoids.built === 1`、`ownerCheck === 'inside'`、`padsIn === 0` | ✅ 三者都满足 |
| `drcLeafCount.leaves === 0` | ✅ **0**（`drcLeaves {n:0}`，`byType` 空） |
| 日志里出现 `holePairNudged` | ✅ **2 条** |
| `holePairSummary.fixed === 2` | ✅ `{total: 2, fixed: 2}` |
| `holePairNoVia` / `holePairTooFar` 不出现 | ✅ 各 0 条 |
| `_run.json.ok` | ✅ **`true`**（首次），`gates.errors=0`、`envFaults=0` |
| `fabcheck` | ✅ exit 0 / 0 阻断 |

两条 `holePairNudged` 的实测值，与第四节的推算逐位吻合（推算 delta=5、方向朝 −x）：

```
{"id":"eea4d737c119eb33","delta":5,"from":[88.9505,-389.316],"at":[99.1385,-389.6400],"to":[83.953,-389.157]}
{"id":"a07c832c37d1bf84","delta":5,"from":[88.9505,-48.7655],"at":[99.1380,-49.0904],"to":[83.953,-48.6061]}
```

`from` 正是钻孔里那个 12.01 mil 孔的中心，`at` 正是违规点，`to` 比原来远 5 mil ——
边距从 8.38 变成 13.38 mil > 12，两条叶子同时消失。

**顺带暴露的下一个缺陷（已修）**：这一轮 attempt 1 自述 `ok=True`，但 `run-all.ps1`
的**独立 DRC 复核**（`scripts/verify-drc.js` 开回工程自己数）连续两次退 2（环境异常），
于是它判「本轮不通过」并 `continue` 进入 `expand-1.25x`（板宽 1300 → 1625）——
一块**一条违规都没有**的板，被一块更宽的板顶替了，而换板没有任何证据支持它更好。

## 六之二、`run-all.ps1` 的三态修正（sha `E6A43A74A954 → 04DC7636BA82`）

两处：

1. **量具读不到输入时不许沉默。** 退 2 的分支原来只打一个退出码，日志里没有一行原因，
   事后分不清是「会话没了」「超时」还是「输出不是 JSON」。现在把 `verify-drc.js` 的
   输出头 6 行打到日志里。
2. **「未能复核」与「查出违规」分开处置。** 查出违规 ⇒ 换方案（当前方案已证实不行）；
   未能测量 ⇒ 对这块板一个判断都没下过，换板没有依据 ⇒ **停止阶梯、保留本轮产物**。
   `$bestDrcReOk` 保持 `$null` ⇒ 终判仍是 false（未复核 ≠ 通过），并把原因写进
   `_gates.independent.json` 的新字段 `gates.drcIndependentNote`（机器可读，
   与 `pipelineSelfOk` 等字段同一套三态）。

踩坑留痕：第一次改这个文件时把 `+` 续行写在了**行首**，PowerShell 报
「表达式中缺少右括号」—— 而 `AGENTS.md` 里明明写着「`+` 必须在行尾才能续行」。
`test/syntax-gate.mjs` 4 秒拦住。另外 `run-all.ps1` 是 **CRLF**，
按 `\n` 写锚点时 `count` 恒为 0，而报错只说「锚点不唯一 count=0」，看不出是换行符的事。


## 七、复核命令

```powershell
# 叶子明细（不需要重跑构建）
py -X utf8 -c "import json,glob,os; d=sorted(glob.glob(r'out\ESP32S3_Wireless_Mic_V5-2026*'))[-1]; L=json.load(open(os.path.join(d,'_log.json'),encoding='utf-8'))['entries']; print([e['v'] for e in L if e['s']=='drcLeaves'])"

# 这条修复路径到底有没有真的动过一次手
py -X utf8 -c "import json,glob,os,collections; d=sorted(glob.glob(r'out\ESP32S3_Wireless_Mic_V5-2026*'))[-1]; L=json.load(open(os.path.join(d,'_log.json'),encoding='utf-8'))['entries']; c=collections.Counter(e['s'] for e in L); print({k:c[k] for k in ('holePairNudged','holePairNoVia','holePairTooFar','holePairSummary')})"
#   修前各轮：holePairNudged 0 / holePairNoVia 2 / holePairTooFar 0 / holePairSummary 2

# 那个孔到底是谁的（钻带算术）
Expand-Archive -Path 'out\ESP32S3_Wireless_Mic_V5-20261126-214236\Gerber.zip' -DestinationPath F:\cache\temp\drill-214236 -Force
Get-ChildItem F:\cache\temp\drill-214236 -Recurse -Filter '*.DRL' | ForEach-Object { Write-Host $_.Name; Select-String -Path $_.FullName -Pattern '^T\d+C' }
```
