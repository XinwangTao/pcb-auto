# 天线净空带有铜吗 —— 用交付的 Gerber 铜层量，不用流水线自述

**问题。** 用户第一条批评是「天线上面不能有任何元器件的遮挡」。流水线里有一个
`antennaKeepout` 判据（`scripts/pipeline3.js` 的 `log('antennaKeepout')`、规则
`NO_COMPONENTS=2 / NO_WIRES=5 / NO_FILLS=6 / NO_POURS=7`、层 12=MULTI），它回答的是
「我建了 region、我数了带内焊盘 / 走线」。那是我自己写的尺子，且 `pcb_PrimitiveRegion`
的 6 个方法全标 `@beta`。**所以换一把尺子：下单实物依据里的铜层。**

## 先说清楚这不是新增检查（否则就是在虚报价值）

`scripts/fabcheck.js` **已经有**同名判据，而且思路完全一样 —— 它自己的注释写着
「3b. 天线净空带：在**最终铜层**上实测，不信设计意图」：

| 判定 id | 级别 | 位置 |
|---|---|---|
| `antenna.keepout.box` | 阻断 | `scripts/fabcheck.js:579` |
| `antenna.keepout.unmeasured` | 阻断 | `scripts/fabcheck.js:581, 624` |
| `antenna.keepout.copper` | **阻断** | `scripts/fabcheck.js:626` |
| `antenna.keepout` | 通过 | `scripts/fabcheck.js:630` |
| `antenna.keepout.silk` | 提示 | `scripts/fabcheck.js:632` |

它从 `_design.snapshot.json` 读 `_antennaKeepout`，算 `boxMm`，逐层数铜/丝印图元，
写进 `facts.antennaKeepout = { boxMm, layers, copperHits, silkHits }`（L623）。

**那为什么还要量一遍？** 因为**这个权威判据对这块板一次都没跑过**。
`run-all.ps1` 里的 fabcheck 调用是**条件化的** —— 只在 `if (-not $v.ok)` 的失败分支里问，
而麦克风板的每次尝试都是 `ok=false`，于是走的是失败报告 + `continue`（L880），
fabcheck 那一段（L968-1006）根本没有到达。**即：下单资格一次都没被问过，天线净空也就一次都没被权威核过。**
（这条本身已记在 `docs/FAILURES.md`，是待修项，不是本文的结论。）

所以两个量具的分工是：`fabcheck` 是**权威**，但它在这条路径上不会被调用；
本文这把尺子是**绕开 `_run.json.ok` 的独立复核**，并且拿到的证据是同一份交付 Gerber。
两者结论一致 ⇒ 天线净空这条不是「我自己的日志说干净」，而是「交付物里确实没有铜」。

## 量法

- 输入：`out\ESP32S3_Wireless_Mic_V5-20261126-195631\Gerber.zip`（v5 第 2 轮第 1 次尝试的交付物）
- 铜层：`Gerber_TopLayer.GTL`、`Gerber_BottomLayer.GBL`（2 层板，无内层）
- 坐标：`%FSLAX45Y45*%` ⇒ 4 整数位 + 5 小数位 ⇒ 坐标字 `÷1e5` 得 mm
- 净空带：`y ∈ [-93.980, -93.726] mm`，即 `[-3700, -3690] mil`
  （板底 = -3700 mil；U1 焊盘区底 = `cy-374 = -3316-374 = -3690 mil`。这两个数不是拍的，
  前者是 `boardHeightMil`，后者在 `_antennaKeepout.why` 里逐项列出）
- 判据：带内铜坐标点数必须为 0

## 结果（2026-11-26T20:16 +08:00）

| 层 | 坐标点数 | 小数位 | X 范围 (mm) | Y 范围 (mm) | 带内点数 |
|---|---|---|---|---|---|
| `Gerber_BottomLayer.GBL` | 1987 | 5 | 0.000 – 32.662 | -93.622 – 0.000 | **0** |
| `Gerber_TopLayer.GTL` | 4811 | 5 | 0.000 – 32.662 | -93.622 – 0.000 | **0** |

分母：**2 个铜层 / 6798 个铜坐标点**。结论 `ANTENNA-GERBER=PASS`。

## 权威量具的独立结论（两者方法不同、结论一致）

对同一份交付物跑 `node scripts\fabcheck.js out\ESP32S3_Wireless_Mic_V5-20261126-195631`：

```
verdict=PASS  exit=0  summary={blockers:0, warnings:4, notes:5, passes:14}
antenna.keepout → 天线净空带（7.01..26.01 × -93.98..-93.726 mm）在 2 个铜层上
                  均无走线/铺铜/焊盘：6033 段 D01 + 333 个闪点全部在带外
antenna.keepout.silk → 带内有 2 个丝印图元
                       （油墨，非铜，不构成电气遮挡；禁布区规则类型里没有丝印档位）
facts.antennaKeepout = {copperHits:0, silkHits:2,
                        GTL:{segs:4220, segHits:0, flash:244, flashHits:0},
                        GBL:{segs:1813, segHits:0, flash:89,  flashHits:0},
                        GTO:{segs:1005, segHits:2}, GBO:{segs:0, segHits:0}}
```

两个量具的计数不同（fabcheck 数 D01 线段与闪点，本文脚本数 X-Y 坐标字），
但**都给出「带内 0 个铜」**。同一结论由两条互不依赖的代码路径得到，这比任何一条单独成立都强。

顺带纠正一条更重要的口径：**这块板 `fabcheck` 判 PASS、0 阻断，是能下单的**，
尽管它的 `_run.json.ok` 是 `false`。这两个数回答的是不同问题（AGENTS.md「三条不许」第 2 条）。
`ok=false` 说的是「流水线自己没跑绿」，`fabcheck=PASS` 说的是「产物能打样」。
拿 `ok=false` 当「板子不能下单」是错的；反过来拿 `ok=true` 当「能下单」也是错的。

`antenna.keepout.silk` 的 2 个图元要如实说：用户的原话是「天线上面不能有任何**元器件**的遮挡」，
丝印是油墨、不是元器件、也不构成电气遮挡，但它确实在带内。禁布区的
`EPCB_PrimitiveRegionRuleType` 里**没有丝印档位**（只有 NO_COMPONENTS=2 / NO_WIRES=5 /
NO_FILLS=6 / NO_POURS=7 / NO_INNER_ELECTRICAL_LAYERS=8 / FOLLOW_REGION_RULE=9），
所以「让丝印也不进带」在本版本没有 API 可用 —— 这条只能记录，不能修。

两点附带事实：

1. 铜的最低点是 **-93.622 mm = -3685.9 mil**，比净空带上沿（-3690 mil）还高 4.1 mil，
   比板边高 14.1 mil —— 即不仅净空带里没铜，整个覆铜也没有爬到模组焊盘区下方。
2. 天线本体悬出到 **-3966.5 mil**，那一段在板外（板边 -3700），本就不该有铜，
   所以「带外」不等于「没检查」：带外 276.5 mil 是天线自己的悬出区。

## 这把尺子的边界（必须写清，否则它会变成下一轮的假绿灯）

- 它只判**铜**。丝印（GTO/GBO）、阻焊、器件的物理占位都不在内 —— Espressif 的要求是
  「严禁铺铜、走线、摆放元件」，元件占用由 `audit-placement.mjs` 的
  `antenna_band_empty` / `antenna_overhang` / `band_covers_antenna` 三条管。
  两把尺子各答各的，不能互相顶替。
- 它假设板框原点在 `(0,0)` 且 `Y∈[-H,0]`（本仓库 `createPolygon(['R',0,0,W,H,0,0])` 的实测
  约定，没有 Y 取反）。换板形时要重取 `boardHeightMil` 与焊盘区底，否则带子会画错地方
  而**照样输出 PASS** —— 这是这类脚本最危险的失效方式，已在脚本里用
  `total_pts == 0 ⇒ 退 2` 与「带子边界取自设计文件而非硬编码」两条来防。
- **侧向 15 mm 净空无法在本板表达**：Espressif 要求天线两侧各 15 mm，而本板宽
  1300 mil = 33.02 mm，两侧各 15 mm 已经把整块板宽吃光。这条已如实标注为「无法满足」，
  不冒充通过（几何上无法满足的判据不是判据）。
- 沿用 `out/_probe/` 的豁免规则：`*.empty.json` 形式的「空样本」不入库。

## 复现

```
& $py -X utf8 F:\cache\temp\verify-antenna-gerber.py
```

脚本读 `Gerber.zip`、按上面的带子统计，退出码 **0**=带内无铜 / **1**=带内有铜 /
**2**=量不出（找不到 zip、没有铜层、一个坐标都没解析出来）。
第 3 种情形故意不跟 1 混：**量具读不到输入时不许沉默，也不许把它算成"板子有问题"**。
