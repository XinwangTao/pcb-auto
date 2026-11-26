# DRC 天花板：v4 的 5 个叶子，2 个是封装固有、改布局永远到不了 0

测于 2026-11-26T19:10+08:00。对象：`out\ESP32S3_Wireless_Mic_V4-20261126-185013`。

## 1. 结论

| 分类 | 条数 | 归属 | 能否靠布局/布线消掉 |
|---|---|---|---|
| `Clearance Error \| Slot Region to Track` | 3 | 一个 **17×17 mil、类型读不出来**的图元 `4e0fd676c06a1f29e37`，在 (650,-251) | 理论上能，但流水线**正确地拒绝**了 |
| `Clearance Error \| Hole to Hole` | 2 | **USB1（Type-C）封装内部：引脚孔 ↔ 壳体槽** | **不能。任何摆放、任何布线、任何板框都改不了** |

> 初版我把 3 条 `Slot Region to Track` 也归给了 Type-C 的槽孔 —— **错了**。
> 日志里那个对象离最近的 Type-C 槽 350 mil 远（`slotGeoCmp.violInRealHole: false`）。
> 名字里有 "Slot" 不等于就是那 4 条槽。这就是「按名字猜归属」的代价。

`drcLeafCount = 5`（`drcTotalCount = 10`，恒为 2×，见 DRC-33-DOSSIER §7）。所以：

- **这块板用这个 Type-C 封装，`_run.json.ok = true` 不可达。** 授予下限是 leaf=2。
- 流水线跑了 6 次运行 / 20+ 次尝试全 `ok:false`，其中这 2 条一直没有任何 heal plan 动过 —— 不是因为没找到办法，是因为**没有布局层面的办法**。

## 2. Hole to Hole 的取证链

DRC 报 `cur=8 need=12`，位置 `(99,-390)` 与 `(99,-49)`，`Multi-Layer`，`net:null`。

我把 `Gerber.zip` 里三份 Excellon 全解出来，槽按**胶囊**（有长度，不是圆点）算边缘间距：

```
圆孔 158 / 槽孔 4  →  去重后 圆孔 81 + 槽孔 4 = 85
```

`85` 与 fabcheck 的 `drill.duplicate`（声明 162 孔 / 唯一 85 孔）**对账一致** ——
这一步很关键：如果不先对账，就分不出「真的没有违规」和「我的解析器看不见槽孔」。

分母 = 85 个唯一孔的全部 3570 对。边缘间距 `< 12 mil` 的：

```
8.38 mil  ROUND T2 d=0.305 @(2.25934,-1.23864)  ✕  SLOT T3 d=0.8 @(3.02434,-1.26304)→(3.72434,-1.26304)
8.38 mil  ROUND T2 d=0.305 @(2.25934,-9.88863)  ✕  SLOT T3 d=0.8 @(3.02437,-9.91296)→(3.72436,-9.91296)
```

y 换算成 mil：`-1.23864/0.0254 = -48.8`、`-9.88863/0.0254 = -389.3` ⇒ 对应 DRC 的 `-49`、`-390`。
第二近的一对是 **18.74 mil**（远宽于 need=12）。所以「只有 2 对」不是采样，是全集。

槽孔在 `Drill_PTH_Through.DRL` 里以 `G85` 表达（`T03C0.80000`，4 条）。这 4 条槽和 2 个孔
共处 Type-C 封装的同一个壳体区 —— 是**库零件自带的几何**。

### 2.1 与流水线日志的三方对账

同一个数从三条独立路径得到，互相印证：

| 来源 | 读数 |
|---|---|
| 我从 `Gerber.zip` 按胶囊几何算 | **8.38 mil** |
| 流水线 `clearDiag` | `cur: 8.382331780485096` |
| 由 `slotKeepout.slots` 的 `at[297,-50] / d=31.496 / len=47.244` 反推 | 8.25 mil（取整差） |

`clearDiag` 原文（两条）：
```
{rule:"otherClearance", t1:"Hole", t2:"Hole", net:null, layer:[12],
 cur:8.382331780485096, need:11.811, at:[99,-390], o1:"f897c50d29dd5a23e59", o2:"2324c4f3e799e61d"}
{rule:"otherClearance", t1:"Hole", t2:"Hole", net:null, layer:[12],
 cur:8.381411869922289, need:11.811, at:[99,-49],  o1:"f897c50d29dd5a23e58", o2:"0ab6e31cffac6ad6"}
```

- `need = 11.811 mil` = 0.3 mm。
- `t2:"Hole"`, `net:null` —— 孔对孔，不涉及网络。
- `o1` 的 id 前缀 `f897c50d29dd5a23` 正是 `slotKeepout.slots` 里那 4 条槽的 id 前缀 ⇒ **一侧是槽**。
- `holePairNoVia` 两条：`{at:[9.914,-38.964], near:79.64, vias:77}` / `{at:[9.91399,-4.909045], near:90.39, vias:77}`
  ⇒ 最近的过孔在 79.64 / 90.39 之外 ⇒ **不涉及过孔**，不是「孔↔过孔」而可缩孔的形态。
- `holePairSummary: {total:2, fixed:0}` —— 流水线试过，一条也没能修。

> ⚠️ 同一份日志里 `clearDiag.at` 用 **mil**（`[99,-390]`），而 `holePairNoVia.at` 用 **mm**
> （`[9.914,-38.964]`）。混着用会得出「这两个不是同一对」的错误判断。

## 2.2 槽孔位置自证（用来排除「坐标看错」）

`slotKeepout.slots` 给了 `at:[297,-50] rot:90 d:31.496 len:47.244`。
四个槽 = 两个 x × 两个 y 的组合，与钻孔文件的 `G85` 端点逐一对上：

```
x = 119..147 mil（中心 133）   和   x = 289..305 mil（中心 297）
y = -49.7 mil                 和   y = -390.3 mil
```

DRC 报的 `[99,-390]` 是**引脚孔**（`2.25934 mm = 88.95 mil`）那一侧的位置。
引脚孔半径 6 mil，槽左端边缘在 `119 - 15.75 = 103.25` mil ⇒ 间隙 `103.25 - (89+6) = 8.25` mil。
三条路径给出的都是「8 点几」，不是巧合。

## 3. 我自己在这轮踩的坑（记下来免得再犯）

第一版解析器只匹配 `X..Y..` 行，把 `G85` 槽**静默丢掉**了 4 个孔，然后据此算出
「最近孔距 18.74 mil，`<12 mil` 的孔对 = 0」—— 一个**看起来完全正常**的错误结论。

唯一让我发现的线索是**对账**：`declared 162 ≠ 我数到的 158`，差的正好 4 个，
而 `holeTypes` 里写着 `SLOT:4`。

> 量具读不到输入时不许沉默。凡是「数出来是 0」的结论，必须先证明分母里没有东西被漏掉。

## 4. 那 3 条 `Slot Region to Track` 到底是什么

`clearanceSkipNoGeo` 原文（三条里重复出现两次的那两行，全部指向同一个对象）：

```
{line:"d078bac6450dd895", net:"GND", obstacleType:"Slot Region",
 objId:"4e0fd676c06a1f29e37", safeBox:[625,-260,649,-237],
 need:12, cur:4, obsSrc:null,
 reason:"obstacle geometry unavailable; corridor reroute forbidden"}
```

`uniGeo` 连续三次给出同一个 `type: null`：

```
{id:"4e0fd676c06a1f29e37", type:null, box:[642,-260,658,-243], wh:[17,17],
 viol:[637,-249], contains:false}
{id:"4e0fd676c06a1f29e37", type:null, box:[642,-260,658,-243], wh:[17,17],
 viol:[650,-248], contains:true}
```

`slotGeoCmp`（一次完整对账）：

```
{objId:"4e0fd676c06a1f29e37", parentId:"4e0fd676c06a1f29", parentOwners:[],
 obWH:[17,17], obCenter:[650,-251], violInFabricatedBox:true,
 violInRealHole:false, violInRealHoleOf:[], slotsTotal:4,
 nearest:[{id:"f897c50d29dd5a23e60", num:"3", net:"GND", xy:[297,-390],
           rot:90, holeD:31.496, ...}]}
```

要点：

1. **`violInRealHole: false`** —— 违规点不落在任何一个真实槽孔里。我原来担心的
   「进音孔/壳体槽是障碍」在这里不成立（至少不是那 4 条槽）。
2. **`nearest` 指向 (297,-390)**，而违规点在 (650,-251)，相距 350+ mil ⇒ 与 Type-C 无关。
3. **`parentOwners: []`** —— 反查父对象拿不到任何归属器件，所以「这是谁的图元」目前**未证实**。
   `obWH:[17,17]` 而 `obBBox` 量出 `[642,-260,658,-243]` = 17×18，**每边差 1 mil**，日志自己不自洽。
4. `reason: "obstacle geometry unavailable; corridor reroute forbidden"` ——
   流水线拿不到障碍物几何时**拒绝改线**。这是**正确行为**（拿虚假几何去绕，会产生新的违规），
   但代价是这 3 条永远不动。要修它，得先让 `uniGeo` 能读出这个图元的几何，
   而不是让布线器猜。

## 5. 因此该怎么做（不是靠再跑一次）

1. **换 USB1 封装**，找壳体槽与引脚孔间距 ≥ 12 mil 的 Type-C 件。这是唯一能把 leaf 从 2 降到 0 的路径。
2. **那 3 条 `Slot Region to Track`** 的真问题不是布线，是 `uniGeo.type = null` ——
   量具读不出障碍物几何，于是一整类违规被永久跳过。先修几何读取，再谈绕线。
3. **不要为了让它变绿去放宽 DRC 的 `need=11.811`。** 0.213 mm 的孔↔槽边缘间隙，
   嘉立创的最小孔间距也是 0.25 mm，真实厂同样会提。
4. **也不要把「换设备」当成流水线的错**。`routeState: completed`、`exportsOk 6/6`、
   未连接 0、`mismatches 0` —— 流水线在这块板上做到了它能做的；剩下的是零件选型问题。

## 6. 再跑一次的收益估计（写清分母）

已知 4 次尝试的数据点（分母 = v4 这一个设计的全部尝试，测于 2026-11-26T19:12+08:00）：

| 尝试 | 板框 | 用时 | leaf | 导出 |
|---|---|---|---|---|
| 1 smart-fit | 1300×3700 | 472 s | **5** | 6/6 |
| 2 expand-1.25x | 1625×3700 | 502 s | **5** | 6/6 |

两块**不同尺寸**的板给出**完全相同**的 leaf 与分类。在「显式摆放 + 封装固有几何」的前提下，
扩板这条 heal plan 在这块板上**原理上无效**：那 5 条钉在零件几何上，不在摆放密度上。
