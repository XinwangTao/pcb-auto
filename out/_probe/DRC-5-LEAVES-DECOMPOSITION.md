# 剩下 5 条 DRC 叶子，逐条查「谁能修」—— 全部在器件封装内部

> 记录时间：2026-11-26 21:2x（Asia/Shanghai）
> 样本：`out/ESP32S3_Wireless_Mic_V5-20261126-210140`（patchG 之后那一次完整构建，
> `_run.json.elapsedMs=449504`，`drcResult={state:"failed", n:5}`）
> 结论：**5 条全部落在器件封装自身的几何上（USB-C 壳体槽 / 连接器孔），
> 不是布线或摆放能修的；其中 2 条流水线结构上没有处理器，2 条连「要修的对象」都读不出来。**
> 同一份产物 `fabcheck` 判 **PASS（0 阻断）**。两件事**不互相证明**，见第五节。

## 一、5 条叶子

| 类型 | 坐标（mil） | cur / need | 网 |
|---|---|---|---|
| `SMD Pad to Track` | (621, −193) | 1 / 6 | GND ↔ 3V3（`clearNet` 实测 `sameNet:false`） |
| `Slot Region to Track` | (636, −249) | 7 / 12 | GND ↔ 槽（`n2` 取不到） |
| `Slot Region to Track` | (650, −248) | **0** / 12 | GND ↔ 槽（`n2` 取不到） |
| `Hole to Hole` | (99, −390) | 8 / 12 | 无 |
| `Hole to Hole` | (99, −49) | 8 / 12 | 无 |

## 二、两个 `Hole to Hole`：流水线**结构上**没有处理器

同一份日志里，`clearanceNoHandler` 一共 5 轮（round 0~4），每一轮的 `uncovered` 都是同一项：

```
{"pair": "Hole×Hole", "n": 2, "why": "无 Via 侧", "bucket": "uncovered"}
```

也就是说：流水线的间距修复器按「Track / Pad / Via」三种对象分类建处理器，
**`Hole×Hole` 这一类两边都不是 Via，所以每轮都被列进 `uncovered` 而无人认领** ——
连续 5 轮，一次都没变。

它倒是**尝试过**另一条路：`holePairSummary` 出现 5 次，每次都是 `{total: 2, fixed: 0}`；
配套的 `holePairNoVia` 给出失败原因：

```
{"at": [9.9138, -38.9640], "near": 79.64, "vias": 94}
{"at": [9.9138, -4.9090],  "near": 90.39, "vias": 94}
```

`at` 是画布单位（mil/10 ⇒ 实际 `(99.1, −389.6)` 与 `(99.1, −49.1)`，与两条叶子**逐点对上**）。
`near` 是「最近的过孔有多远」：**79.64 / 90.39 画布单位 = 796 / 904 mil**，而板上 94 个过孔全都在别处。

**含义：这条修复路径的设计意图是「在违规孔附近加一个地孔来满足孔到孔的间距」。
而孔到孔的间距问题，加过孔在几何上根本不可能解决 —— 最近的地孔在 0.8~0.9 英寸
（796 / 904 mil ≈ 20 / 23 mm）之外，而两条违规孔之间的间隙只有 8.39 mil 需要补到 11.81。
加多少个地孔都改不了两个既有孔的相对位置。** 所以 `fixed: 0` 不是「这次没修好」，
是这条路径**在原理上就不适用于这个违规类别**。

## 三、两个 `Slot Region to Track`：连被修的对象都读不出来

同一份日志里 4 条 `clearanceSkipNoLine`，其中两条正对这两处叶子：

```
{"line": "945...", "t1": "Track", "t2": "Slot Region",
 "obj1": "949b7b55d7f285ec", "obj2": "717005a2323c8d47e37", "cur": 6, "need": 12,
 "reason": "pcb_PrimitiveLine.get 返回空 ⇒ 这条违规无人处理"}
{"line": "241...", "t1": "Track", "t2": "Slot Region",
 "obj1": "241cfa647825c725", "obj2": "717005a2323c8d47e37", "cur": 0, "need": 12,
 "reason": "pcb_PrimitiveLine.get 返回空 ⇒ 这条违规无人处理"}
```

`obj1` 是走线 id，`pcb_PrimitiveLine.get` 对它**返回空**。所以连「这条线多长、什么走向」都拿不到，
更不可能去挪它。

配套的 `slotGeoCmp`（8 条）还给了两件更关键的事：

```
{"objId": "717005a2323c8d47e37", "obBBox": [642, -260, 658, -243], "obWH": [17, 17],
 "obCenter": [650, -251],
 "viol": [650, -248], "violInFabricatedBox": true,  "violInRealHole": false, "violInRealHoleOf": []}
{"objId": "717005a2323c8d47e37", "obBBox": [642, -260, 658, -243],
 "viol": [636, -249], "violInFabricatedBox": false, "violInRealHole": false, "violInRealHoleOf": []}
```

- 流水线给这个「Slot Region」拼出来的包围盒只有 **17×17 mil**（`obWH`），
- 而两条违规点**都在真实孔里找不到**（`violInRealHole: false`，`violInRealHoleOf: []`），
- 其中一个连「在拼出来的盒子里」都不成立（`violInFabricatedBox: false`）。

这是本项目反复出现的形态：**`@alpha` 级的几何接口给不出真几何，于是代码用拼出来的盒子近似，
再由这个近似盒子判出违规。** 判出来的点落不进任何真实孔 —— 这条判据的输入本身就是可疑的。

修还是试过的：`trackDogleg` 3 次（GND 线 vs Slot Region，`cur 2→9→9`，`push 14/7/6`），
每次都推动了，但最终 DRC 里仍有 2 条。**推得动一点，消不掉。**

## 四、一个 `SMD Pad to Track`：有处理器，修不住

`clearanceNoHandler` round 1 与 round 3 的 `covered` 里都有 `Track×SMD Pad`
（`why: "无 Via 侧"`，但在 `covered` 桶 —— 说明有处理器）。它最终仍然留下 1 条，
`cur=1 / need=6`，对象是 GND 走线与 **U4 的 3V3 焊盘（pin 3）**，`sameNet:false`。

这一条是 5 条里**唯一一条有机会真修好的**：它是 3V3 与 GND 的异网擦边，间隙只剩 1 mil。
它也是唯一一条和摆放有关的（U4 是 MEMS 麦，C9 在它西侧 20 mil 处）。
机制假设与验证方式见 `BYPASS-CAP-MISPLACEMENT.md` 第七节 —— **未验证，不许当结论。**

## 五、同一份产物，`fabcheck` 判 PASS —— 但这两件事不互相证明

```
node scripts/fabcheck.js out/ESP32S3_Wireless_Mic_V5-20261126-210140 --raw
⇒ verdict: PASS   exit 0
   summary: {blockers: 0, warnings: 4, notes: 5, passes: 14}
```

4 项警告全部与电气/间距无关：丝印出框 46 个图元（丝印会被裁，可接受）、
同一孔位被登记 94 次（`drill.duplicate`，计费翻倍但 CAM 通常自动去重）、
PnP 是 TAB 分隔、PnP 是 utf16le 编码。5 项说明里有一项正好对上本节的槽：
`drill.slots` —— 「4 条 G85 胶囊槽按 1 个电镀孔计，槽长 0.40/0.70/0.70/0.40 mm」。

**必须分开说的两句话：**

1. `fabcheck` PASS 说明的是：**按它测的那批判据（Gerber/钻孔/PnP 的可制造性），0 条阻断。**
2. 它**不等于**「那 5 条 DRC 叶子无害」。fabcheck 的判据集合里没有「电镀槽边缘到走线」
   这一档，所以它不是「查过并放行」，是**这一档没查**。

同理，`_run.json.ok` 仍是 `false`，因为它的唯一失败原因是那 5 条 DRC 叶子；
而 `_run.json.ok` 也**不是**可下单性判据（`docs/FAILURES.md` 第 15 条）。

**三个测量，三个不同的问题：**

| 测量 | 回答的问题 | 本轮结果 |
|---|---|---|
| `fabcheck` exit code | 按它的判据，能不能下单 | **0 / PASS** |
| `_run.json.ok` | 流水线自己的全绿条件是否满足 | **false**（唯一原因：5 条 DRC 叶子） |
| `drcResult.n` | 引擎报了几条几何违规 | **5**（性质见上四节） |

## 六、该怎么办（按顺序）

1. **`Hole×Hole`**：`clearanceNoHandler` 应该把 `Hole×Hole` 明确登记成
   「该类违规本流水线不处理」，而不是每轮塞进 `uncovered` 让人以为是待办。
   `holePairNoVia` 这条「加地孔」路径要么删掉、要么加一条前提检查
   （最近地孔 > 某阈值时直接判「不适用」），否则它永远报 `fixed: 0` 却耗着预算。
2. **`Slot Region`**：`ensureGeoIdx` 漏了 `pour`/`poured`（第 27 条）与
   `pcb_PrimitiveLine.get` 返回空，是同一个根：**几何索引不完整**。
   在索引修好之前，`slotGeoCmp` 报的 `violInRealHole: false` 本身就该让这条违规进
   `unverifiable` 桶，而不是进 `failed`。
3. **`SMD Pad to Track` @(621,−193)**：先做 C9 隔离实验，别急着改修复器。
4. **记账**：`_run.json` 的 DRC 统计应把叶子分成
   `packageInternal` / `unhandleable` / `fixable` 三类，而不是一个 `n: 5`。
   否则「5 条」这个数字会被读成「还有 5 处布线没做好」，而实际上其中 4 处连处理器都没有。

## 七、复核命令

```powershell
cd D:\Users\陶鑫旺\Documents\deepseek-harness\default-workspace\pcb-auto
node scripts\fabcheck.js 'out\ESP32S3_Wireless_Mic_V5-20261126-210140' --raw
#   期望 verdict=PASS exit 0 / blockers 0

py -X utf8 -c "import json,io,collections; L=json.load(io.open(r'out\ESP32S3_Wireless_Mic_V5-20261126-210140\_log.json',encoding='utf-8'))['entries']; c=collections.Counter(e['s'] for e in L); print({k:c[k] for k in ('clearanceNoHandler','clearanceSkipNoLine','holePairNoVia','holePairSummary','slotGeoCmp','trackDogleg')})"
#   期望 clearanceNoHandler 5 / clearanceSkipNoLine 4 / holePairSummary 5（全 fixed:0）/ slotGeoCmp 8 / trackDogleg 3
```
