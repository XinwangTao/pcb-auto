# FAB-GAPS · 7 条缺口复查

快照：2026-11-25 20:20。**全程只读**：未开 EDA、未调 `lceda-pro.exe`、未跑 `run-all.ps1`；pipeline3.js 只读不写（该文件 20:15 仍在被实时修改，行号仅对本快照有效，定位请用 grep 关键词）。
工具：`E:\APP\nodejs24\node.exe`（v24.19.0），全离线——ZIP/OOXML/Gerber/NC 用 Node 内置模块解析，不依赖 xlsx 模块、python、pwsh。

## 0 结论速览

|#| FAB-AUDIT §4 缺口 | 校验器是否仍漏 | 产物侧现状 | 阻断 |
|---|---|---|---|---|
| ① | TestPoints 不校验 | **仍漏**（verify-artifacts 全文无 TestPoints 引用） | **仍存在**，且非确定性 | 否 |
| ② | 钻孔只数文件名不数孔 | **仍漏**（v-a.js:338-344 只数 `.DRL` 个数） | **仍存在**：6/6 抽查有重复孔 | 否 |
| ③ | 元件值↔物料不比对 | **仍漏** | **仍存在**：4 份 run 命中 4.7k/1.2k→实发 1k | **是（会错件）** |
| ④ | 板框只要 `d01+d03≥3` 不验闭合 | **仍漏**（v-a.js:411） | 12/12 抽查实际闭合且尺寸对 | 否 |
| ⑤ | 空层不查、丝印阈值 3 太松 | **仍漏**（v-a.js:414-419 只查 GTS/GTO，GBS/GBO 完全不查） | GBO 每份都 0 图元（合规） | 否 |
| ⑥ | PDF 只看字节数 | **仍漏**（v-a.js:427-430） | 6/6 均 `%PDF-1.4`/6 页/`%%EOF` | 否 |
| ⑦ | PnP 单位写死 mm×39.37、不断言表头 | **仍漏**（v-a.js:352、357-359） | 仍混杂（见 §2） | 否 |

"仍漏"= 校验器代码自审计以来未改，洞还在；"仍存在"= 产物里真的能抓到。两者都已由新检查器 `scripts\fabcheck.js` 补上（②③⑦ 直接可判，①⑤⑥ 见下）。

## 1 重点 A：DRL 是否重复登记 —— **是，6/6 命中，未解决**

口径与证据（`Gerber.zip` 内，逐文件解析 `T▸C▸` 刀具表后数坐标）：

| run 目录 | 声明孔数 | 唯一孔数 | 重复 | 文件 |
|---|---|---|---|---|
| LED_RGB_Indicator-20261125-193838 | 14 | 11 | 3 | Through 11 + Via 3 |
| RP2040_Minimal-20261125-194222 | 86 | 47 | 39 | 47 + 39 |
| RP2040_QSPI_Flash-20261125-195838 | 60 | 30 | **30（100%）** | 30 + 30 |
| USBC_Power_ESD-20261125-191510 | 56 | 35 | 21 | 33 + 21 + NPTH 2 |
| AI_传感器___充电___显示…-184722 | 52 | 32 | 20 | 32 + 20 |
| SHT30_I2C_TempHumidity-20261125-185516 | 10 | 9 | 1 | 9 + 1 |

机制已定位：**`Drill_PTH_Through.DRL` 已包含全部过孔，`Drill_PTH_Through_Via.DRL` 又把同一批过孔单独导一遍**。证据（LED_RGB 目录）：
- `Drill_PTH_Through.DRL` 453B，工具 `T01C0.30480`(3 孔)/`T02C1.00000`(8 孔)；`Drill_PTH_Through_Via.DRL` 259B，`T01C0.30480`(3 孔)。
- 坐标 `X19.58207Y-7.56854` 两份文件各出现一次，孔径同为 0.3048；Via 坐标集合 ⊂ Through，差集 = 0，交集孔径全同。
- 即：**跨文件登记**，不是同文件内重复——孔数计费按声明数走（14 vs 11），不去重的厂会二次钻孔。
- 判级：**警告，不阻断**（嘉立创 CAM 惯例自动去重）。fabcheck 输出 `drill.duplicate` + 前 5 对坐标。

## 2 重点 B：GBO/GBS 是否 0 字节 —— **不是 0 字节，GBO 是 0 图元**

`out\LED_RGB_Indicator-20261125-193838\Gerber.zip`（14 项，26504B）解包后逐字节：

| 层 | 字节 | D01 | D02 | D03 | G36 | 判定 |
|---|---|---|---|---|---|---|
| GBO（底丝印） | **631** | 0 | 0 | 0 | 0 | 有 `G04`×11 + `%ADD10C,0.254*%`/`%ADD11C,0.0159*%` + `G54D10*`，**0 图元** |
| GBS（底阻焊） | **1140** | 0 | 0 | **8** | 0 | 8 个 D03 = J1 的 8 个插件孔开窗，与 PTH 1.0mm×8 完全一致 |
| GTS | 1451 | 0 | 0 | 16 | 0 | 16 焊盘开窗（= SMD 16） |
| GTO | 5089 | 126 | 53 | 0 | 0 | 顶丝印 179 个图元，正常 |
| GTL/GBL | 15875/11334 | 523/381 | 42/20 | 19/11 | 1/1 | 有铜有走线 |

结论：**不是 0 字节**，而是"只有头、没有几何"（上次审计的 "GBO 0 图元" 才对）。判定必须语义化：
- GBO 空 + 该板**有**底面器件（PnP `Layer=B`）→ 阻断（背面无位号）。
- GBO 空 + 全顶面器件（本次 6/6 run 的 PnP `Layer` 全是 `T`）→ 正常，仅记录。
- GBS 空 + 有插件孔（PTH 去掉 Via 后非空）→ 阻断（插件孔不开窗焊不了）；`RP2040_QSPI_Flash-195838` 的 GBS 也是 0 图元，但它的 PTH 只剩 0 个真插件孔（全是过孔重复），两层自洽，故非阻断。
fabcheck 即按此判：`gerber.mask.bottom.empty` / `gerber.silk.bottom.empty` 视 `bottomParts` 决定 blocker 还是 note。

## 3 其余五条细节

**① TestPoints**：v-a.js 完全不看该文件。`fix-artifacts.js:24-33` 只在 run-all 的"自述通过"分支被调用（`run-all.ps1:415`），而 `record-full.ps1:67`、`d7d8-run.ps1:72`、`record-real.ps1:75` 直接调 pipeline3 → 不经过 fix。实测并存两种状态：
- `out\LED_RGB_Indicator-20261125-193838\TestPoints.xlsx` 8107B（已改名，正确；3 sheet，sharedStrings 含"测试点覆盖率"、"0%"）；
- `out\RP2040_Minimal-20261125-194222\TestPoints.csv` 8306B，头 `50 4b 03 04 0a 00` = ZIP/xlsx（名字骗人，CSV 解析器必崩）。
根因在导出侧：`pipeline3.js:1965` 把 `getTestPointFile()` 的返回值直接命名 `.csv`。

**③ 值↔物料**：v-a.js 无此比对（只在 §4 给了粘贴代码）。实测命中——`SHT30_LDO_Module-193402`、`SHT30_Module_Full-193042`、`SHT30_Module_Full-185314` 的 `R1,R2 标 4.7k`、`AI_…-192147` 的 `R1,R2 标 4.7k` + `R4 标 1.2k`，四条全指向 `0402WGF1001TCE`（`C11702` = 1kΩ）→ 实发 1k。反例：`LED_RGB-193838` 的 `1kΩ/C11702`、`5.1kΩ/0402WGF5101TCE` 相符，说明判据不误报。这一条我按**警告**输出（`bom.value.mismatch`），因为它不改 PCB 可制造性，但会错件。

**④ 板框**：v-a.js:411 仍只 `d01+d03<3`。实测 12/12 的 GKO 都是 4×D01 + 首点回环闭合、尺寸与 `_run.json` 毫厘不差（LED_RGB 30.48×22.86mm = 1200×900mil）。→ 产物没坏，校验器仍漏。

**⑤ 空层/丝印**：v-a.js:414-419 仅 GTS/GTO 且 `n<3`。GBS/GBO 从未检查。另测出丝印轻微超框（`ESP32C3_Minimal-185851` GTO 9 个图元到 X=51.417，板宽 50.8，超 0.6mm）——印刷会被裁，可接受，fabcheck 记为警告。

**⑥ PDF**：v-a.js:427-430 只看 `size>10000`。实测 6/6 为 `25 50 44 46 2d 31 2e 34`（`%PDF-1.4`）、6 页、尾部 `%%EOF`。

**⑦ PnP**：v-a.js:352 精确取 `Mid X`，:357-359 写死 `*39.3701`。现状混杂：UTF-16LE（`ff fe`，5 份）与 UTF-8 BOM（`ef bb bf`）并存；TAB 与逗号并存；`"13.122mm"` 与裸 `17.532` 并存，后缀有无与 run 时间无规律（`LED_RGB-193838` 无、`RP2040_Minimal-194222` 有）。导出意图是 mm（`pipeline3.js:1963` 第三参 `'mm'`），但下游不该靠猜：fabcheck 用 `后缀 > mmol 拟合`（仅当 mm 落不进板框、mil 落得进且全整数才判 mil）。

## 4 建议改动（**只建议，未动手**）

pipeline3.js（导出段 `grep -n "const EXPORT_PLAN"`，快照行号 1960-1976）：
1. **:1965** `['TestPoints.csv', …]` → `['TestPoints.xlsx', …]`。getter 返回的本来就是 xlsx 字节流，改名即治愈 ①（比在 run-all 里事后改更确定）。
2. **:1968-1975 循环后、:1976 之前**加"导出后归一"三步（本进程内、不依赖 EDA）：a. PnP UTF-16→UTF-8、TAB→逗号、剥 `mm` 后缀；b. DRL 删掉 `*_Via.DRL` 中与 `PTH_Through.DRL` 重合的坐标（或整份丢弃，Through 已含 Via）；c. 写回同名文件。→ 治愈 ②⑦。
3. **:1976 之后** spawn 一次 `node scripts\fabcheck.js <OUT>`，把 `blockers[].msg` 并入 `errors`（"产物不可打样"应进 `ok:false`，而不是只靠 run-all 事后判定）。
4. 不建议改 `verify-artifacts.js` / `fix-artifacts.js`（另一循环在用）；新判据全落在 `fabcheck.js`。run-all.ps1:424 前加一行 fabcheck 即可白嫖（单目录实测 ~0.2s）。

## 5 复现

```
E:\APP\nodejs24\node.exe scripts\fabcheck.js "out\LED_RGB_Indicator-20261125-193838"             # exit 0，0 阻断/1 警告
E:\APP\nodejs24\node.exe scripts\fabcheck.js --selftest "out\LED_RGB_Indicator-20261125-193838"  # 造坏样本，断言 exit 1
```
