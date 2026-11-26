# 设计电气缺陷修复报告

范围：`designs\*.json`（22 个）+ 生成器 `scripts\idea2design.js`（§5 说明）+ 本报告。
全程未碰 LCEDA / lceda-pro.exe / EDA 会话 / run-all.ps1 / run-overnight.ps1；未改 `_catalog.json` 与 `audit-design.js`。
所有改动用「写 `<file>.tmp` → `Move-Item -Force`」原子落盘，22/22 文件 `ConvertFrom-Json` 通过。

验证：`& 'E:\APP\nodejs24\node.exe' scripts\audit-design.js` → **退出码 0**，22/22 PASS，想法编译产物 0 问题。

## 1. 逐设计修改

| 设计 | 原失败项 | 实际做的修改 | 结果 |
|---|---|---|---|
| d1-sht30 | U1 SDA/SCL 悬空（SDA/SCL 网络只有 J1 一脚） | 补 `U1.2→SDA`、`U1.3→SCL`（复用已有网络） | PASS |
| d4-sht30-header | 同上 | 补 `U1.2→SDA`、`U1.3→SCL` | PASS |
| d6-rp2040-minimal | XIN/XOUT 悬空 | 声明 NC（无晶振） | PASS |
| d7-rp2040-flash | USB_DP/DM、XIN/XOUT、SWCLK/SWD 悬空 | 6 条 NC | PASS |
| d11-crystal-rtc | 10 脚悬空（USB_DP/DM、SWCLK/SWD、QSPI×6） | 10 条 NC | PASS |
| d13-solar-oled-logger | U1(SHT30) EP 悬空；U3(TP4056) STDBY 悬空 | `U1.9→GND`；`U3.STDBY` NC | PASS |
| gen-demo | U1(SHT30) EP 悬空 | `U1.9→GND` | PASS |
| gen-rp2040 | QSPI×6 半截网络（只剩 U1）；XIN/XOUT 悬空 | 删 6 条单脚连接（无 Flash 对端）+ 8 条 NC | PASS |
| gen-rp2040-v2 | RUN/SWCLK/SWD 半截网络；XIN/XOUT 悬空 | 删 3 条单脚连接 + 5 条 NC（板上无任何连接器） | PASS |
| gen-做一个-RP2040-最小系统板… | 同上 | 同上 | PASS |
| gen-做一个-SHT30… | U1 EP 悬空 | `U1.9→GND` | PASS |
| gen-做一个-TP4056… | STDBY 悬空 | `U1.STDBY` NC | PASS |
| gen-做一个太阳能…记录仪 | U1 EP 悬空；U3 STDBY 悬空 | `U1.9→GND`；`U3.STDBY` NC | PASS |
| gen-做一个-8-路-LED… | 电源网 5V 无源件（板无任何连接器） | 加 `H1=C9900192758 8P` 排针：`H1.1→5V`，`H1.2..8→GND` | PASS |

其余 8 个设计（d2/d3/d5/d8/d9/d10/d12/gen-led）原本就是 PASS，未改。

## 2. noConnect 逐条理由（39 条，全部为 C 类「确实没用」）

| 文件 | 声明的 noConnect | 理由 |
|---|---|---|
| d6-rp2040-minimal | U1.XIN, U1.XOUT | 板上无晶振 Y1；RP2040 可用内部环形振荡器，XIN/XOUT 不接合法 |
| d7-rp2040-flash | U1.USB_DP, U1.USB_DM | 板上无 USB 连接器，USB 功能硬件上不存在 |
| d7-rp2040-flash | U1.XIN, U1.XOUT | 同 d6，无晶振 |
| d7-rp2040-flash | U1.SWCLK, U1.SWD | 板上无调试排针/测试点（只有 U/C/R/LED） |
| d11-crystal-rtc | U1.USB_DP, U1.USB_DM | 无 USB 连接器；H1 是时钟引出排针，不是 USB 口 |
| d11-crystal-rtc | U1.SWCLK, U1.SWD | H1（8P）8 脚已全占用：XTAL_IN/XTAL_OUT/RTC_XIN/RTC_XOUT/3V3/RUN/GND×2，无空闲脚做 SWD，设计里也没有调试器座 |
| d11-crystal-rtc | U1.QSPI_SCLK, QSPI_SD0, QSPI_SD1, QSPI_SD2, QSPI_SD3, QSPI_SS | 板上无 Flash 器件（无 C131025/W25Q16），六根线没有对端 |
| d13-solar-oled-logger | U3.STDBY | TP4056 只用了 CHRG# 一路状态灯（LED2）；STDBY# 是开漏输出，不接合法 |
| gen-rp2040 | U1.QSPI_SCLK, QSPI_SD0, QSPI_SD1, QSPI_SD2, QSPI_SD3, QSPI_SS | 板上无 Flash 器件；原 6 条网络都只剩 U1 一脚，属半截网络，按 C 类撤销 |
| gen-rp2040 | U1.XIN, U1.XOUT | 无晶振 |
| gen-rp2040-v2 | U1.RUN, U1.SWCLK, U1.SWD | 该设计里没有任何连接器/测试点可引；RUN 有内部上拉，悬空不会停机 |
| gen-rp2040-v2 | U1.XIN, U1.XOUT | 无晶振 |
| gen-做一个-RP2040… | U1.RUN, U1.SWCLK, U1.SWD | 同上（无连接器；RUN 内部上拉） |
| gen-做一个-RP2040… | U1.XIN, U1.XOUT | 无晶振 |
| gen-做一个-TP4056… | U1.STDBY | 同 d13，STDBY# 未用 |
| gen-做一个太阳能… | U3.STDBY | 同 d13，STDBY# 未用 |

**没有任何 B 类（本该连接的）信号被声明成 NC**：SHT30 的 SDA/SCL 在 d1/d4 已实连；有 Flash 的板（d6/d7/gen-rp2040-v2/gen-做RP2040）QSPI 全部实连到 W25Q16；有排针的板（d6/d11/gen-rp2040）RUN/SWCLK/SWD 按规则引到排针或被占满后说明理由。

## 3. 残留问题（均不阻塞审计，未改）

1. **AMS1117 TAB(4) 悬空**（d10/d12/d6/d7/d13/gen-rp2040/gen-rp2040-v2/gen-做RP2040）：审计只算 note（TAB 电气上等于 VOUT，输出走 pin2，悬空只丢散热）。建议后续接 VOUT(3V3)，本次未动以收窄改动面。
2. **d11、gen-rp2040 板上无 Flash**：QSPI 只能 NC，这两块 RP2040 板无法从外部 Flash 启动（功能缺陷，非电气危障）。建议补 W25Q16（C131025）。
3. **d11 的 H1 已满**：若需 SWD 调试，要么占用时钟引出脚，要么换 10P 排针/加专用 SWD 座。
4. **引脚级校验盲区**：d10 `U1 C2934560`、d11 `Y1 C9002 / Y2 C32346 / C1-C4 C1548`、d12 `J1 C165948 / U1 C7519` 未登记 `_catalog`，审计无法核引脚号（沿用原状态）。
5. **d1 无板载 I2C 上拉**：模块式设计，依赖主机侧上拉；若单独使用需补 2×4.7k。
6. **gen-rp2040-v2 / gen-做RP2040 无复位按键、无 RUN 外部上拉**（依赖 RP2040 内部上拉）。

## 4. connections 数量对比

合计 **740 → 744（+16 / −12，净 +4）**。增加的均为补连/电源入口；减少的 12 条全是「只剩 1 脚、对端不存在」的半截网络（C 类），已逐条换成 NC 声明，未掩盖应连信号。

| 文件 | 前 → 后 |
|---|---|
| d1-sht30 | 9 → 11 (+2) |
| d4-sht30-header | 13 → 15 (+2) |
| d13-solar-oled-logger | 49 → 50 (+1) |
| gen-demo | 18 → 19 (+1) |
| gen-做一个-SHT30… | 18 → 19 (+1) |
| gen-做一个太阳能… | 49 → 50 (+1) |
| gen-做一个-8-路-LED… | 38 → 46 (+8) |
| gen-rp2040 | 56 → 50 (−6，C 类单脚网络) |
| gen-rp2040-v2 | 58 → 55 (−3，C 类单脚网络) |
| gen-做一个-RP2040… | 58 → 55 (−3，C 类单脚网络) |

## 5. 范围说明：为什么动了 `scripts\idea2design.js`

`audit-design.js` 末尾的「想法编译产物审计」会用 `idea2design.js --dry` 现场编译 5 条想法再审计，这 7 个问题（SHT30 EP 悬空×3、TP4056 STDBY×3、RP2040 XIN/XOUT×1）是**生成器缺陷**，只能在上游修，改 `designs\*.json` 无法影响它们——它们正是初始 19 个 FAIL 里的 5 个条目。该脚本是纯离线编译器，不建会话、不碰 EDA。改动共 6 处：
1. SHT30 配方补 `EP→GND`（DFN-8 散热焊盘电气上就是 GND）；
2. `addCharger()` 对 TP4056 登记 `STDBY` 为 noConnect；
3. RP2040 配方登记 `XIN/XOUT` 为 noConnect（配方不带晶振）；
4. `compile()/finish()` 增加 noConnect 透传（只在有声明时输出该字段，不自动猜）；
5. 4 个 `finish(...)` 调用点与 2 个 `addCharger(...)` 调用点同步传参。

回归：`node scripts/test-idea2design.js` → **16 通过 / 0 失败**。备份：`F:\cache\temp\pcb-repair-backup\idea2design.js.bak`。
若该文件属于禁区，请回滚它并接受「想法编译产物 7 问题 / 退出码 1」——但那样任务目标「全部设计通过审计」无法达成。

## 6. 验证记录（真跑）

```
& 'E:\APP\nodejs24\node.exe' scripts\audit-design.js   → EXIT 0
   合计 22 个设计，0 个电气问题 / 想法产物：0 个电气问题
& 'E:\APP\nodejs24\node.exe' scripts\test-idea2design.js → EXIT 0，16 通过 / 0 失败
Get-Content -Raw <每个 designs\*.json> | ConvertFrom-Json → 22/22 OK，0 报错
```

STATUS={"status":"ok","changed":["designs/ 下 14 个：d1-sht30, d4-sht30-header, d6-rp2040-minimal, d7-rp2040-flash, d11-crystal-rtc, d13-solar-oled-logger, gen-demo, gen-rp2040, gen-rp2040-v2, gen-做一个-RP2040…, gen-做一个-SHT30…, gen-做一个-TP4056…, gen-做一个太阳能…, gen-做一个-8-路-LED…","scripts/idea2design.js","scripts/DESIGN-REPAIR.md"],"verify":{"cmd":"node scripts/audit-design.js","exit":0},"reason":"22/22 设计 PASS：SHT30 SDA/SCL 补连 U1.2/3、EP 接 GND；TP4056 STDBY、无晶振 XIN/XOUT、无 USB 口 USB_DP/DM、无对端 QSPI 按 C 类显式 NC；8 路 LED 板补 8P 排针做 5V 入口；另修生成器（否则审计内置想法段恒 7 问题、退出码 1）"}
