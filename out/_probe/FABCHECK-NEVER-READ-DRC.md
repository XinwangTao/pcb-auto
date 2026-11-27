# fabcheck 的洞：它被当成「能不能下单的唯一权威」，却从不读 DRC

> 实测 2026-11-27。分母：`out/` 下 **80 个**带 `_run.json` 的目录（扫于 2026-11-27T18:0x+08:00）。

## 缺陷

对抗性审查报过：三块**已被作废**的板跑 fabcheck **全是 exit 0 / 0 阻断**，
其中 `ESP32S3_Wireless_Mic_V5-20261126-214236` 的 `_run.json` 自己写着 `drcLeafCount: 2`。

根因不是判据写错，而是 **fabcheck 根本没读 DRC** —— `_run.json` 只被用来核对板框尺寸。

而 `AGENTS.md` 把这个闸门写成「唯一的权威是 `fabcheck` 的退出码」。
于是一块电气上还有 2 条叶子的板，会拿到一份 `verdict: PASS` 的报告。

## 语料面影响

| | |
|---|---|
| 带 `_run.json` 的目录 | **80** |
| 其中有 `gates.drcLeafCount` 读数 | **70** |
| 缺该字段（会发 `run.drc.missing` 提醒，不再沉默） | 10 |
| **`drcLeafCount > 0` ⇒ 从 PASS 改判 FAIL** | **26 / 70（37%）** |

最大的几条：`ESP32S3_Wireless_Mic_V2-20261126-152721`（131 叶）、`-154422`（105）、
`Crystal_RTC_Clock-20261126-085027`（78）、`V3-20261126-162010`（62）。

审查者举的那块现在：

```
$ node scripts/fabcheck.js out/ESP32S3_Wireless_Mic_V5-20261126-214236
exit=1    "verdict": "FAIL"    "id": "drc.leaves.open"
```

## 修法：两条方向相反的改动

**1. 单向加严**（`drc.leaves.open`）
自述 `gates.drcLeafCount > 0` ⇒ 阻断。**只用「有叶子」去否决，绝不用「没叶子」去背书** ——
否则独立复核就被生产者自己的话替代了，而那正是这个项目一直在防的事。

**2. 常驻声明**（`scope.electrical`）
每次输出都带一条：

> 本闸门**不查**电气间距 / 短路 / 网表连通性 —— 那三件由 EDA 的 DRC 与独立复核
> `scripts/verify-drc.js` 负责。本文件的 PASS 只表示「产物本身可制造」。

这样「PASS」不能被读成「没有短路」。

**3. 没有读数也不许沉默**（`run.drc.missing`）
旧产物的 `_run.json` 里没有 `gates` 字段时发提醒 —— 这一维没有读数，不能默认当成没问题。

## 闸门

`test/fabcheck-drc-scope-gate.mjs`（第 24 关，11 条断言，4 个场景）：

| 场景 | 断言 |
|---|---|
| 没有 `_run.json` | 仍通过；**永远**带 `scope.electrical`；不编阻断 |
| 自述 2 条叶子 | exit 1、`verdict:FAIL`、点名 `drc.leaves.open` |
| 自述 0 条叶子 | exit 0、不阻断，且**不新增任何 drc 相关 pass 记录**（防独立性被替代） |
| 有 `_run.json` 无 `gates` | 发 `run.drc.missing` 提醒，但也不编阻断 |

变异用例也补了一条（`test/mutants/fabcheck.catalog.json` 的 `drc.leaves.open`，用 `write` op
造一份带叶子的 `_run.json`）：**mutants 16/16 命中，覆盖判据 15 / 72（20.8%）**。

## 仍然不查的（写清楚，不假装）

`fabcheck` 依然**不做自己的电气 DRC**：离线判「两个不同网络的铜是否太近」需要
网表 ↔ Gerber 的焊盘级归属，那是独立工程。现在的边界是：

- **电气间距/短路**：EDA DRC + `scripts/verify-drc.js`（独立复核，真机跑）；
- **产物可制造性**：fabcheck；
- **能不能下单**：两者的合取（`run-all` 的 `$finalOk`），且 fabcheck 现在会把
  「DRC 自述有叶子」当成阻断。

换句话说：**这一轮补的不是电气判据，而是「把电气结论接进判决 + 说清自己不看什么」。**
真正补电气判据仍是一个未完成项。
