# EP 地孔尺寸闸门与仍开着的 3V3↔GND 短路

> 测于 2026-11-26T20:50:22+08:00（`out/ESP32S3_Wireless_Mic_V5-20261126-203952/_run.json`，
> `elapsedMs=613416`）。分母一律是**那一次运行自己的日志**，不是整个 `out\` 语料。
> 修复提交 `07a70e6`（patchG）。

## 一、已修：`preVia` 在装不下孔的焊盘上打了孔

### 数字

同一次运行的 DRC 报了 4 条 `Clearance Error | SMD Pad to Via`，`cur` **全是 0**：

| 坐标（mil） | cur | need |
|---|---|---|
| (625, −2041) | **0** | 6 |
| (591, −2095) | **0** | 6 |
| (729, −1744) | **0** | 6 |
| (729, −1676) | **0** | 6 |

`cur=0` 不是「差一点」，是**两块铜直接相接**。日志里 `epViaAt` 共 9 条，其中 4 条的焊盘坐标
与上表**逐点对上**，且它们的 `near`（到最近非 GND 焊盘的距离）全部落在 **19.4~25.6 mil**。

### 根因

```js
if ((hasUp && hasDown) || (hasLeft && hasRight)) enclosed.push(g);
```

只问「上下（或左右）十五 mil 之外有没有别的焊盘」，**不问焊盘自己多大**。
U3 是 MAX98357A、0.5mm 间距 ⇒ 相邻盘心正好 **19.7 mil** ⇒ 那一排中间引脚天然左右都有邻居
⇒ 全被判成「被本体包围的 EP 焊盘」。而被判中的焊盘实测包围盒只有 **10×24 / 24×10 mil**
（`getPrimitivesBBox` 逐盘读），比要打的孔外径 **19.7 mil 还窄**。

### 修法与闸门

`EP_VIA_NEED = 19.7 + 2×6 = 31.7 mil`（6 mil 取自本板 DRC 实测 `need`）。两个方向都要装得下才打孔；
装不下（`padTooSmall`）或读不到包围盒（`noBBox`）都不打，各留一条 `epViaSkip` 账。
`epVias` 改为带分母：`{count, candidates, skipped, skipBy, note:"candidates = count + skipped"}`。

闸门 `test/epvia-size-gate.mjs`：30 条断言 / 6 场景，跑的是**文件里真实落地的那段代码**加桩依赖。
其中「放行大盘」是 positive control —— 没有它，一个永远返回 false 的闸门也能全绿，
那等于把短路换成「GND 一个地孔都没有」。

### 双向证明（四个方向，逐字节还原）

| 变异 | 破坏 | 结果 |
|---|---|---|
| M1 | 拿掉尺寸闸门（退回盲打孔） | exit 1，**12 条**断言失败 |
| M2 | 闸门永远拦住（连 60×60 大盘也拦） | exit 1，**11 条**失败 |
| M3 | 分母造假（`skipped` 恒 0） | exit 1，**5 条**失败 |
| M4 | 边界写反（`<=` 代替 `<`） | exit 1，**1 条**失败 |

四轮均还原到 `sha256_12=E433D662DA70`，字节差 0，复绿 exit 0。

## 二、仍开着：`(479, −304)` 的 3V3↔GND 真短路

**这一条 patchG 没修**，它跟地孔无关。证据全部来自同一个 `_log.json`：

`clearNet` 判定 `sameNet:false`，两侧网分别是 3V3 与 GND：

| 对象对 | 类型 | 两侧网 | cur | need |
|---|---|---|---|---|
| `9b4cb2af68245fe4` ↔ `4f30f868e2dc111de15` | Track ↔ SMD Pad | GND ↔ **3V3**（padNum 1） | **0** | 5.98 |
| `027ed0eda67a9eab` ↔ `4f30f868e2dc111de15` | Track ↔ SMD Pad | GND ↔ **3V3**（padNum 1） | **0** | 5.98 |
| `e7c405fe803e1326` ↔ `9b4cb2af68245fe4` | Track ↔ Track | 3V3 ↔ GND | **0** | 4.02 |
| `712cd3281cda1a36` ↔ `027ed0eda67a9eab` | Track ↔ Track | 3V3 ↔ GND | 2.84 | 4.02 |

**定位。** `4f30f868e2dc111de15` 是 net 3V3 的 1 号焊盘，位置在 `(479, −304)` —— 那是
**C9（100nF，去耦 U4 的 3V3）的 3V3 焊盘**。两条 6.5 mil 宽的 GND 走线从这个焊盘身上穿过去。

**为什么它没被修掉。** 同一份日志里 `clearanceRound` 第 3 轮 `{violations:13, fixed:5}`，
随后 `clearanceReverted`：`{deleted:2, restored:0, viaRestored:4, from:13, to:20,
why:"这一轮 clearance 越修越多，整轮撤回"}`。也就是说修复器**试过**，
但它的动作让违规从 13 涨到 20，于是整轮回滚 —— 短路被原样留下。
另有 4 条 `clearanceCorridorNone`（无绕行走廊）与 6 条 `clearanceThinHopeless`。

**这条为什么比地孔那 4 条更危险。** 它把 3V3 与 GND 直接接在一起：上电就是电源对地短路。
地孔那 4 条是「焊盘与过孔相碰」，同样不可接受，但至少方向是同一个网。

**遗留的判断（未验证，不许当结论）。** 一个 0603 被摆在 U4 正西 70 mil、离 U4 左边缘
约 50 mil 的位置，可能正好占住了从 U4 的 GND 引到铺铜的唯一走廊。若如此，正确的修法
是**布局级**的（把 C9 挪到不堵走廊的位置，或给 U4 的 GND 引脚留一条明确的出线方向），
而不是继续加大间距修复器的力度。**这一点需要一次隔离实验才能确认，本轮没做。**

## 三、这条缺陷的读法（给下一个人）

这个仓库的缺陷大多数是「报了个好看的数，其实没测」。这条方向相反：
**流水线在没人看的时候主动造了一个缺陷**。

地孔自动补全是纯增益动作，没人会去核对它；而它的失败形态是**短路而不是断路**，
且 DRC 只报成若干条 `Clearance Error`，很容易被当成「间距余量」放过去。
所以凡「自动补全 / 自动优化」类动作，都必须有一条**可量的前置条件**，
以及一条在条件不满足时的**记账**——沉默地跳过和沉默地执行一样危险。

## 四、怎么复核

```
node test/epvia-size-gate.mjs          # 30 条断言 / 6 场景
node test/syntax-gate.mjs              # 14 道闸门里的第 1 道
py -X utf8 F:\cache\temp\prove-red-epvia-gate.py 1   # 反向证明（1/2/3/4，restore 还原）
```

取证源文件：`out/ESP32S3_Wireless_Mic_V5-20261126-203952/_log.json`
（`epViaAt` ×9 · `epVias` ×1 · `clearDiag` ×8 · `clearNet` ×8 · `clearanceReverted` ×1）。
