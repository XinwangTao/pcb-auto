# 嘉立创 EDA projects 历史工程清理报告

生成时间：2026-11-27 10:06:11（Asia/Shanghai）  ·  执行人：eda-cleanup（DSH subagent）  ·  机器：本机 Windows / pwsh 7

> 所有数字都带分母与时刻：目录数分母 = 清理前 `projects` 下的 253 个子目录；字节分母 = 同一时刻 `Get-ChildItem -Recurse -File` 的实测和；规则命中分母 = 同上 253。

## 0. 结论一句话

清理前 **253** 个工程目录 / **364,881,430** B（347.98 MiB）→ 清理后 **77** 个 / **150,630,020** B（143.65 MiB）；**176** 个未命中任何保护规则的工程整体 `Move-Item` 到 `F:\cache\eda-trash\20261127-100257`（实测 **214,251,410** B，204.33 MiB）。数量守恒 176+77=253，字节守恒 364,881,430−150,630,020=214,251,410 **完全相等**（误差 0.00%），EDA `session list` 清理后仍 `ok:true`。

## 1. 清理前基线（实测）

| 项目 | 值 |
| --- | --- |
| 工程目录数 | 253（`Get-ChildItem -Directory`，projects 下无散落文件） |
| 总字节 | 364,881,430 B = 347.98 MiB = 0.340 GiB |
| 时间跨度 | 2026-10-26 12:35:05 → 2026-11-27 01:03:56（约 32 天） |
| 最近 2 小时内改动 | 0 个 |
| 最新一个 | `ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxso6bj`，2026-11-27 01:03:56，2,668,443 B |
| D 盘剩余 | 120,384,847,872 B = 112.117 GiB |
| 空间目的 | 否——D 盘远未满，本次目的是整洁与可检索性 |

## 2. 候选目录确认（只列，不动）

| 目录 | 内容 | 处置 |
| --- | --- | --- |
| `LCEDA-Pro\example-projects` | 5 个官方示例文件（`示例工程_3D外壳设计.eprj2` 等，合计 71,359,232 B），**0 个子目录** | 存在；一律不动（保护规则 #5） |
| `LCEDA-Pro\database` | 1 项 | 配置/库，不动（硬约束 #3） |
| `LCEDA-Pro\logs` | 2 项 | 不动 |
| `LCEDA-Pro\images`、`libraries`、`online-projects-backup`、`projects-recovery` | 各 0 项 | 不动 |
| `LCEDA-Pro\config.json`、`lceda-pro-activation.txt` | 2 个文件 | 不动 |

本次写入面严格限定为：`LCEDA-Pro\projects` 下的工程子目录（移出）+ 本报告 + 回收目录内清单文件。`pcb-auto\` 只读了 `out\**`、`logs\**`，未改任何文件。

## 3. 判定口径（保护规则的实现方式）

| 代号 | 规则 | 实现 |
| --- | --- | --- |
| K1 | 最新 **20** 个（mtime 降序） | `Sort-Object mtime -Descending` 取前 20 → 命中 **20** |
| K2 | mtime 晚于 `2026-11-27 00:00` | `-gt [datetime]"2026-11-27 00:00:00"` → 命中 **1** |
| K3 | 名字含 `ESP32-S3 无线麦克风` 且在最近 24 小时内 | 清理时刻 2026-11-27 10:00:11，窗口 `>= 2026-11-26 10:00:11` → 命中 **47**（名字含该串的共 47 个，全部落在窗口内；另有 1 个早期英文命名 `ESP32-S3-INMP441-Wireless-Microphone` 不含该串，按规则不属主项目族） |
| K4 | 工程名在 `pcb-auto\out\*\` 或 `pcb-auto\logs\` 被提到过 | 见下 |
| K5 | `example-projects` 一切 | 不在 projects 内，未参与任何移动 |

**K4 的具体做法**：把 `pcb-auto\out\**` + `pcb-auto\logs\**` 下 1,049 个文本文件（.json/.log/.txt/.md/.html/.ps1/.csv 等，单文件 <8MB）的全文，加上这两棵树下**所有文件的文件名与所在目录名**，拼成一串 12,568,318 字符的 blob；对 253 个工程目录名做 **ordinal 子串匹配**（`String.Contains`，区分全半角与「（）」「：」等字符）。命中 62 个。

**一个必须说清的口径选择**：若把「去掉尾部 `_xxxxxxxx` 的基名」也当工程名匹配，会命中 185 个；但这些命中几乎全是设计模板的 `"friendly"` 字段（例：`"friendly": "12MHz + 32.768kHz 时钟电路"`），指的是**这类设计**而不是**某个具体工程实例**——同一基名的 60 个实例不可能都被同一行模板文字引用。因此判定按题目要求「用**工程目录名**做子串匹配」执行：只有完整目录名出现才算引用。62 个命中全部能定位到具体文件，且 1:1 对应一次自动布线运行的 `"projectName"` 字段，是真引用。

## 4. 判定表

| 结果 | 数量 | 原因分类 | 计数 |
| --- | --- | --- | --- |
| **保留** | **77** | 当前主项目族（K3 主因：名称含 ESP32-S3 无线麦克风且 mtime 在 24h 内） | 47 |
| | | pcb-auto 在用工程（K4，且不在 K1/K2/K3 内） | 30 |
| **移走** | **176** | 历史迭代：同名基名仍有更近实例被保留（stale-iteration） | 170 |
| | | 一次性探测工程 `PROBE_0000~0003`（probe-temp） | 4 |
| | | 无引用遗留工程（legacy-unreferenced：`BoardTestProbe`、`ESP32-S3-INMP441-Wireless-Microphone`） | 2 |

**N + M = 77 + 176 = 253 = 清理前目录数 253 ✓**（保留分类计数 47+30=77，移走分类计数 170+4+2=176）

规则命中矩阵（原始命中数，含重叠）：K1 最新 20 = **20**；K2 晚于 11-27 00:00 = **1**；K3 主项目 24h = **47**；K4 pcb-auto 引用 = **62**；四者取并集 = **77**（即保留数 N）。其中 **40** 个工程同时命中 2 条及以上（例：`_mwxso6bj` 同时命中 K1+K2+K3+K4、`_mwxp9clw` 命中 K1+K3+K4），故「原因分类计数」按主因互斥拆分，保证加和等于 N：K3 主因 47 + K4 主因 30 = 77。

## 5. 保护名单命中明细

### 5.1 最新 20 个（mtime 降序，全部保留）

| # | 工程目录名 | mtime | bytes | 同时命中 |
| --- | --- | --- | --- | --- |
| 1 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxso6bj | 2026-11-27 01:03:56 | 2,668,443 | K3-main-project-mic-24h+K1-top20-newest+K2-after-2026-11-27T00:00+K4-pcbauto-referenced |
| 2 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxp9clw | 2026-11-26 23:29:48 | 2,670,032 | K3-main-project-mic-24h+K1-top20-newest+K4-pcbauto-referenced |
| 3 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxori99 | 2026-11-26 23:14:26 | 2,671,221 | K3-main-project-mic-24h+K1-top20-newest+K4-pcbauto-referenced |
| 4 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxnh5yv | 2026-11-26 22:36:27 | 2,670,601 | K3-main-project-mic-24h+K1-top20-newest |
| 5 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxn8cjz | 2026-11-26 22:29:44 | 2,671,221 | K3-main-project-mic-24h+K1-top20-newest+K4-pcbauto-referenced |
| 6 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxm2fqh | 2026-11-26 21:55:11 | 2,738,024 | K3-main-project-mic-24h+K1-top20-newest |
| 7 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxlrcz4 | 2026-11-26 21:51:13 | 2,809,700 | K3-main-project-mic-24h+K1-top20-newest+K4-pcbauto-referenced |
| 8 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxkqygc | 2026-11-26 21:27:31 | 2,679,575 | K3-main-project-mic-24h+K1-top20-newest+K4-pcbauto-referenced |
| 9 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxkkbm3 | 2026-11-26 21:09:39 | 420,454 | K3-main-project-mic-24h+K1-top20-newest |
| 10 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxkana1 | 2026-11-26 21:09:13 | 2,716,723 | K3-main-project-mic-24h+K1-top20-newest+K4-pcbauto-referenced |
| 11 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxjvrt2 | 2026-11-26 20:53:03 | 2,666,883 | K3-main-project-mic-24h+K1-top20-newest |
| 12 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxjil9a | 2026-11-26 20:50:08 | 2,695,430 | K3-main-project-mic-24h+K1-top20-newest+K4-pcbauto-referenced |
| 13 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxiuy9i | 2026-11-26 20:24:46 | 2,670,843 | K3-main-project-mic-24h+K1-top20-newest |
| 14 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxilbib | 2026-11-26 20:21:28 | 2,658,120 | K3-main-project-mic-24h+K1-top20-newest+K4-pcbauto-referenced |
| 15 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxiaiqt | 2026-11-26 20:07:24 | 1,669,609 | K3-main-project-mic-24h+K1-top20-newest |
| 16 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxhywm2 | 2026-11-26 20:05:33 | 2,694,057 | K3-main-project-mic-24h+K1-top20-newest+K4-pcbauto-referenced |
| 17 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxhpbd5 | 2026-11-26 19:52:18 | 2,666,883 | K3-main-project-mic-24h+K1-top20-newest |
| 18 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxhdb77 | 2026-11-26 19:49:04 | 2,694,057 | K3-main-project-mic-24h+K1-top20-newest+K4-pcbauto-referenced |
| 19 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxh5ir3 | 2026-11-26 19:37:44 | 2,676,267 | K3-main-project-mic-24h+K1-top20-newest |
| 20 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxgvh8s | 2026-11-26 19:33:44 | 2,699,723 | K3-main-project-mic-24h+K1-top20-newest+K4-pcbauto-referenced |

> 第 20 名 mtime = 2026-11-26 19:33:44（`ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxgvh8s`）。20 个全在「ESP32-S3 无线麦克风 v3」主项目族内，与 K3 完全重叠，所以 K1 没有带来额外保留；K1 的独立价值是兜住「万一主项目族之外有刚改过的工程」——本次实测没有。

### 5.2 被 pcb-auto `out\**` / `logs\**` 引用到的工程（62 个，全部保留）

| # | 工程目录名 | mtime | 首次命中文件（相对 `pcb-auto\`） |
| --- | --- | --- | --- |
| 1 | ESP32-C3 最小系统板_mwwm9tfc | 2026-11-26 05:13:31 | `out\ESP32C3_Minimal-20261126-050915\_log-1-smart-fit.json` |
| 2 | 12MHz + 32.768kHz 时钟电路_mwwmfj0l | 2026-11-26 05:17:56 | `out\Crystal_RTC_Clock-20261126-051342\_log-1-smart-fit.json` |
| 3 | 12MHz + 32.768kHz 时钟电路_mwwmkws4 | 2026-11-26 05:22:11 | `out\Crystal_RTC_Clock-20261126-051342\_log-2-expand-1.25x.json` |
| 4 | 12MHz + 32.768kHz 时钟电路_mwwmqf4q | 2026-11-26 05:28:54 | `out\Crystal_RTC_Clock-20261126-051342\_log-3-expand-1.25x-retry.json` |
| 5 | 12MHz + 32.768kHz 时钟电路_mwwmz0hj | 2026-11-26 05:33:13 | `out\Crystal_RTC_Clock-20261126-051342\_log-4-expand-1.25x-retry2.json` |
| 6 | USB Type-C 供电与 ESD 保护板_mwwn51wz | 2026-11-26 05:38:02 | `out\USBC_Power_ESD-20261126-053328\_log-1-smart-fit.json` |
| 7 | USB Type-C 供电与 ESD 保护板_mwwnar5y | 2026-11-26 05:42:07 | `out\USBC_Power_ESD-20261126-053328\_log-2-expand-1.25x.json` |
| 8 | USB Type-C 供电与 ESD 保护板_mwwng14m | 2026-11-26 05:46:15 | `out\USBC_Power_ESD-20261126-053328\_log-3-expand-1.25x-retry.json` |
| 9 | USB Type-C 供电与 ESD 保护板_mwwnlc58 | 2026-11-26 05:50:25 | `out\USBC_Power_ESD-20261126-053328\_log-4-expand-1.25x-retry2.json` |
| 10 | RP2040_QSPI_Flash_mwwpdjrx | 2026-11-26 06:39:00 | `out\RP2040_QSPI_Flash-20261126-063608\_log-1-smart-fit.json` |
| 11 | RP2040_QSPI_Flash_mwwph6d9 | 2026-11-26 06:41:49 | `out\RP2040_QSPI_Flash-20261126-063608\_log-2-expand-1.25x.json` |
| 12 | AI_传感器___充电___显示_18p4sgg_mwwtkfr4 | 2026-11-26 08:37:27 | `out\AI_传感器___充电___显示_18p4sgg-20261126-083239\_log-1-smart-fit.json` |
| 13 | AI_传感器___LDO_11p4flb_mwwtpv1l | 2026-11-26 08:40:06 | `out\AI_传感器___LDO_11p4flb-20261126-083741\_log-1-smart-fit.json` |
| 14 | AI_传感器___LDO_16p2sh2_mwwtt88y | 2026-11-26 08:42:53 | `out\AI_传感器___LDO_16p2sh2-20261126-084018\_log-1-smart-fit.json` |
| 15 | AI_SHT30_TempHumidity_mwwtwuhn | 2026-11-26 08:44:57 | `out\SHT30_I2C_TempHumidity-20261126-084306\_log-1-smart-fit.json` |
| 16 | AI_SHT30_TempHumidity_mwwtz3kl | 2026-11-26 08:47:24 | `out\SHT30_I2C_TempHumidity-20261126-084306\_log-2-expand-1.25x.json` |
| 17 | ESP32-C3 最小系统板_mwwu2m6h | 2026-11-26 08:50:14 | `out\ESP32C3_Minimal-20261126-084735\_log-1-smart-fit.json` |
| 18 | 12MHz + 32.768kHz 时钟电路_mwwu6bq4 | 2026-11-26 08:53:13 | `out\Crystal_RTC_Clock-20261126-085027\_log-1-smart-fit.json` |
| 19 | 12MHz + 32.768kHz 时钟电路_mwwu9shp | 2026-11-26 08:56:30 | `out\Crystal_RTC_Clock-20261126-085027\_log-2-expand-1.25x.json` |
| 20 | 12MHz + 32.768kHz 时钟电路_mwwudzq2 | 2026-11-26 09:02:39 | `out\Crystal_RTC_Clock-20261126-085027\_log-3-expand-1.25x-retry.json` |
| 21 | 12MHz + 32.768kHz 时钟电路_mwwulvi5 | 2026-11-26 09:08:53 | `out\Crystal_RTC_Clock-20261126-085027\_log-4-expand-1.25x-retry2.json` |
| 22 | USB Type-C 供电与 ESD 保护板_mwwuug7q | 2026-11-26 09:11:52 | `out\USBC_Power_ESD-20261126-090912\_log-1-smart-fit.json` |
| 23 | USB Type-C 供电与 ESD 保护板_mwwuxs1j | 2026-11-26 09:14:28 | `out\USBC_Power_ESD-20261126-090912\_log-2-expand-1.25x.json` |
| 24 | USB Type-C 供电与 ESD 保护板_mwwv3r8n | 2026-11-26 09:19:04 | `out\USBC_Power_ESD-20261126-090912\_log-3-expand-1.25x-retry.json` |
| 25 | USB Type-C 供电与 ESD 保护板_mwwv75bt | 2026-11-26 09:21:47 | `out\USBC_Power_ESD-20261126-090912\_log-4-expand-1.25x-retry2.json` |
| 26 | AI_OLED_底板_5p5g6m_mwwvazp3 | 2026-11-26 09:28:55 | `out\AI_OLED_底板_5p5g6m-20261126-092206\_log-1-smart-fit.json` |
| 27 | AI_OLED_底板_5p5g6m_mwwvjmgq | 2026-11-26 09:35:35 | `out\AI_OLED_底板_5p5g6m-20261126-092206\_log-2-expand-1.25x.json` |
| 28 | AI_OLED_底板_5p5g6m_mwwvs89u | 2026-11-26 09:42:28 | `out\AI_OLED_底板_5p5g6m-20261126-092206\_log-3-expand-1.25x-retry.json` |
| 29 | AI_OLED_底板_5p5g6m_mwww129v | 2026-11-26 09:49:07 | `out\AI_OLED_底板_5p5g6m-20261126-092206\_log-4-expand-1.25x-retry2.json` |
| 30 | AI_OLED_底板_5p5g6m_mwx14smn | 2026-11-26 12:11:58 | `out\AI_OLED_底板_5p5g6m-20261126-092206\_log.json` |
| 31 | ESP32-S3 无线麦克风_mwx4s7r6 | 2026-11-26 13:55:16 | `out\ESP32S3_Wireless_Mic-20261126-134738\_log-1-smart-fit.json` |
| 32 | ESP32-S3 无线麦克风_mwx52muh | 2026-11-26 14:03:14 | `out\ESP32S3_Wireless_Mic-20261126-134738\_log.json` |
| 33 | ESP32-S3 无线麦克风_mwx5c6m5 | 2026-11-26 14:25:38 | `out\ESP32S3_Wireless_Mic-20261126-140310\_log-1-smart-fit.json` |
| 34 | ESP32-S3 无线麦克风_mwx6mbb5 | 2026-11-26 15:18:59 | `out\rec-result.json` |
| 35 | ESP32-S3 无线麦克风（手持长条板 v2）_mwx8e690 | 2026-11-26 15:35:57 | `out\ESP32S3_Wireless_Mic_V2-20261126-152721\_log-1-smart-fit.json` |
| 36 | ESP32-S3 无线麦克风（手持长条板 v2）_mwx91ojr | 2026-11-26 16:14:59 | `out\ESP32S3_Wireless_Mic_V2-20261126-154422\_log.json` |
| 37 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxa91ug | 2026-11-26 16:29:50 | `out\ESP32S3_Wireless_Mic_V3-20261126-162010\_log.json` |
| 38 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxbcg8m | 2026-11-26 17:09:23 | `out\ESP32S3_Wireless_Mic_V3-20261126-163653\_log.json` |
| 39 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxc9sl1 | 2026-11-26 17:23:18 | `out\ESP32S3_Wireless_Mic_V3-20261126-171654\_log-1-smart-fit.json` |
| 40 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxci66r | 2026-11-26 17:29:41 | `out\ESP32S3_Wireless_Mic_V3-20261126-171654\_log-2-expand-1.25x.json` |
| 41 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxcq4ot | 2026-11-26 17:35:59 | `out\ESP32S3_Wireless_Mic_V3-20261126-171654\_log-3-expand-1.25x-retry.json` |
| 42 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxcy83x | 2026-11-26 17:43:52 | `out\ESP32S3_Wireless_Mic_V3-20261126-171654\_log-4-expand-1.25x-retry2.json` |
| 43 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxdrgzu | 2026-11-26 18:12:04 | `out\ESP32S3_Wireless_Mic_V3-20261126-175901\_log-1-smart-fit.json` |
| 44 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxe8x43 | 2026-11-26 18:23:22 | `out\ESP32S3_Wireless_Mic_V3-20261126-175901\_log-2-expand-1.25x.json` |
| 45 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxen5xv | 2026-11-26 18:33:23 | `out\ESP32S3_Wireless_Mic_V3-20261126-175901\_log-3-expand-1.25x-retry.json` |
| 46 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxf009r | 2026-11-26 18:43:01 | `out\ESP32S3_Wireless_Mic_V3-20261126-175901\_log-4-expand-1.25x-retry2.json` |
| 47 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxflaqq | 2026-11-26 18:57:55 | `out\ESP32S3_Wireless_Mic_V4-20261126-185013\_log-1-smart-fit.json` |
| 48 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxfvgma | 2026-11-26 19:06:06 | `out\ESP32S3_Wireless_Mic_V4-20261126-185013\_log-2-expand-1.25x.json` |
| 49 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxg69m4 | 2026-11-26 19:13:30 | `out\ESP32S3_Wireless_Mic_V4-20261126-185013\_log-3-expand-1.25x-retry.json` |
| 50 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxgfj2p | 2026-11-26 19:21:21 | `out\ESP32S3_Wireless_Mic_V4-20261126-185013\_log-4-expand-1.25x-retry2.json` |
| 51 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxgvh8s | 2026-11-26 19:33:44 | `out\ESP32S3_Wireless_Mic_V4-20261126-192608\_log-1-smart-fit.json` |
| 52 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxhdb77 | 2026-11-26 19:49:04 | `out\ESP32S3_Wireless_Mic_V5-20261126-193938\_log-1-smart-fit.json` |
| 53 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxhywm2 | 2026-11-26 20:05:33 | `out\ESP32S3_Wireless_Mic_V5-20261126-195631\_log-1-smart-fit.json` |
| 54 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxilbib | 2026-11-26 20:21:28 | `out\ESP32S3_Wireless_Mic_V5-20261126-201359\_log-1-smart-fit.json` |
| 55 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxjil9a | 2026-11-26 20:50:08 | `out\ESP32S3_Wireless_Mic_V5-20261126-203952\_log-1-smart-fit.json` |
| 56 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxkana1 | 2026-11-26 21:09:13 | `out\ESP32S3_Wireless_Mic_V5-20261126-210140\_log-1-smart-fit.json` |
| 57 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxkqygc | 2026-11-26 21:27:31 | `out\ESP32S3_Wireless_Mic_V5-20261126-211421\_log.json` |
| 58 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxlrcz4 | 2026-11-26 21:51:13 | `out\ESP32S3_Wireless_Mic_V5-20261126-214236\_log-1-smart-fit.json` |
| 59 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxn8cjz | 2026-11-26 22:29:44 | `out\ESP32S3_Wireless_Mic_V5-20261126-222113\_log-1-smart-fit.json` |
| 60 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxori99 | 2026-11-26 23:14:26 | `out\ESP32S3_Wireless_Mic_V5-20261126-230443\_log-1-smart-fit.json` |
| 61 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxp9clw | 2026-11-26 23:29:48 | `out\ESP32S3_Wireless_Mic_V5-20261126-231945\_log-1-smart-fit.json` |
| 62 | ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxso6bj | 2026-11-27 01:03:56 | `out\ESP32S3_Wireless_Mic_V5-20261127-005256\_log-1-smart-fit.json` |

这 62 个全部对应到具体运行目录（`out\<设计>-<时间戳>\_log*.json`）和/或 `logs\<同名>.json`，命中点是日志里的 `"projectName":"<工程目录名>"` 字段。也就是说：**62/253** 的工程名曾在 pcb-auto 的运行记录里出现过，其余 **191/253** 一次都没有。


## 6. 移出明细（176 个）

按基名汇总（基名 = 去掉尾部 `_a1b2c3d4` 形式的 8 位随机后缀）：

| 基名 | 清理前实例 | 保留 | 移走 | 说明 |
| --- | --- | --- | --- | --- |
| 12MHz + 32.768kHz 时钟电路 | 60 | 8 | 52 | 存在更新的保留实例，旧实例属历史迭代 |
| RP2040_QSPI_Flash | 54 | 2 | 52 | 存在更新的保留实例，旧实例属历史迭代 |
| USB Type-C 供电与 ESD 保护板 | 41 | 8 | 33 | 存在更新的保留实例，旧实例属历史迭代 |
| ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道） | 37 | 37 | 0 |  |
| ESP32-C3 最小系统板 | 28 | 2 | 26 | 存在更新的保留实例，旧实例属历史迭代 |
| AI_传感器___充电___显示_18p4sgg | 8 | 1 | 7 | 存在更新的保留实例，旧实例属历史迭代 |
| AI_OLED_底板_5p5g6m | 5 | 5 | 0 |  |
| ESP32-S3 无线麦克风（手持长条板 v2） | 5 | 5 | 0 |  |
| ESP32-S3 无线麦克风 | 5 | 5 | 0 |  |
| AI_SHT30_TempHumidity | 2 | 2 | 0 |  |
| PROBE_1001_bwqs | 1 | 0 | 1 | 整族移走：无引用、非最新、非主项目 |
| PROBE_1003_3qdp | 1 | 0 | 1 | 整族移走：无引用、非最新、非主项目 |
| AI_传感器___LDO_16p2sh2 | 1 | 1 | 0 |  |
| BoardTestProbe | 1 | 0 | 1 | 整族移走：无引用、非最新、非主项目 |
| PROBE_1000_7fa1 | 1 | 0 | 1 | 整族移走：无引用、非最新、非主项目 |
| ESP32-S3-INMP441-Wireless-Microphone | 1 | 0 | 1 | 整族移走：无引用、非最新、非主项目 |
| PROBE_1002_prat | 1 | 0 | 1 | 整族移走：无引用、非最新、非主项目 |
| AI_传感器___LDO_11p4flb | 1 | 1 | 0 |  |

点名 6 个不属「同名迭代」的移出对象：`PROBE_1000_7fa1`、`PROBE_1001_bwqs`、`PROBE_1002_prat`、`PROBE_1003_3qdp`（各 6,341 B，2026-11-24 23:51 的探测残留）、`BoardTestProbe`（87,296 B，11-25 17:54）、`ESP32-S3-INMP441-Wireless-Microphone`（1,792,553 B，10-26 12:35，全库最早的一个，英文命名的早期实验）。

全量 176 条的逐条依据（每条的 `reason` 已写明基名/规则代号）：`F:\cache\eda-trash\20261127-100257\inventory.json`（253 条）与 `_move-log.json`（176 条源→目标映射）。

## 7. 清理后与对账

| 指标 | 清理前 | 清理后 | 变化 |
| --- | --- | --- | --- |
| projects 目录数 | 253 | 77 | −176 |
| projects 总字节 | 364,881,430 | 150,630,020 | −214,251,410 |
| D 盘剩余 | 120,384,847,872（112.117 GiB） | 120,601,317,376（112.319 GiB） | +216,469,504 B（+206.44 MiB） |
| D 盘剩余（报告生成时复测 10:06:11） | — | 120,595,140,608 | — |
| 回收目录 `F:\cache\eda-trash\20261127-100257` | — | 176 个工程目录 / 1307 个文件 / **214,251,410 B**（204.33 MiB） | — |
| 回收目录（含 inventory.json / README.txt / _move-log.json / _move-summary.json 4 个元数据文件） | — | 1311 个文件 / 214,420,345 B（204.49 MiB） | — |

口径说明：D 盘剩余是**活读数**——两次读数之间本机还有别的进程在写盘（报告生成时复测为 120,595,140,608 B，比移动刚结束时又少了 6,176,768 B），所以 D 盘增量（+216,469,504 B）与「文件字节减少量 214,251,410 B」本来就不会逐字节相等：跨卷删除后 NTFS 回收簇的成本、以及并发写入都会影响。**真正的守恒证据是下面的工程目录字节差 vs 回收目录实测字节（0 误差）**，不是 D 盘读数。

**字节守恒校验**

```
projects 减少量        = 364,881,430 - 150,630,020 = 214,251,410 B
回收目录工程实际字节   = 214,251,410 B  （逐个目录移动后重新 Get-ChildItem 实测）
差额                   = 0 B   → 误差 0.0000%（允许 <5%）
D 盘释放               = 216,469,504 B（与文件字节差 2,218,094 B：簇对齐 + 并发写入，见上口径说明）
保留 + 移走            = 150,630,020 + 214,251,410 = 364,881,430 B = 清理前总字节 364,881,430 B ✓
```

## 8. 验证输出（本机实跑，原样粘贴）

### 8.1 一站式复核（最后实际跑的一条，exit 0）

```
PS> pwsh -NoProfile -File F:\cache\temp\eda-cleanup\verify.ps1
[1] inventory 条目         = 253（keep 77 + move 176）          -> OK
[2] projects 现存目录数    = 77  = keep 77                      -> OK
[3] 保留的 77 个全部仍在  = 缺失 0 个                          -> OK
[4] 移走的 176 个已不在原处 = 仍存在 0 个                        -> OK
[5] 移走的 176 个都在回收目录 = 缺失 0 个                        -> OK
[6] 字节守恒 364881430 - 150630020 = 214251410  vs 回收实测 214251410  -> OK
[7] 字节误差 0.0000%（阈值 <5%）                   -> OK
[8] EDA session list       = ok:true True / alive 会话 2 个 / exit 0 / 1.2s -> OK
[9] lceda-pro 进程仍在      = 6 个（未 taskkill）                  -> OK
VERIFY OK  (7/7 算术与状态判据 + EDA ok:true + 进程存活)
EXITCODE=0
```

判据 [1] 就是「移走 + 保留 = 原 253」的数量守恒：77 + 176 = 253。

### 8.2 EDA 仍可用（移动前后各跑一次 `session list`）

```
PS> & 'E:\APP\lceda-pro\lceda-pro.exe' session list      # 移动前
{"ok":true,"value":[{"sessionId":"3ad4c4d4-43e1-4773-bd2c-c1d70df278eb","renderId":1,"status":"alive","headless":false,"origin":"user","path":null,"title":"嘉立创EDA(专业版) - V4.1.111"},{"sessionId":"4de002b2-f17c-4789-9be0-c22c3d3f095a","renderId":2,"status":"alive","headless":true,"origin":"cli","path":null,"title":"ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxso6bj | 嘉立创EDA(专业版) - V4.1.111"}],"logs":[],"durationMs":0}
exit=0  elapsed=17.4s
```

```
PS> & 'E:\APP\lceda-pro\lceda-pro.exe' session list      # 移动后
{"ok":true,"value":[{"sessionId":"3ad4c4d4-43e1-4773-bd2c-c1d70df278eb","renderId":1,"status":"alive","headless":false,"origin":"user","path":null,"title":"嘉立创EDA(专业版) - V4.1.111"},{"sessionId":"4de002b2-f17c-4789-9be0-c22c3d3f095a","renderId":2,"status":"alive","headless":true,"origin":"cli","path":null,"title":"ESP32-S3 无线麦克风（手持长条板 v3：加宽逃逸通道）_mwxso6bj | 嘉立创EDA(专业版) - V4.1.111"}],"logs":[],"durationMs":0}
exit=0  elapsed=1.3s  · ok:true = True
```

两次输出逐字段一致：GUI 会话（renderId 1，`origin:"user"`）与 headless 会话（renderId 2，`origin:"cli"`，正打开主项目 `_mwxso6bj`）都在 `alive`，`ok:true`。全程未执行 `taskkill lceda-pro`；清理后 6 个 `lceda-pro` 进程仍在（启动时间 22:56~23:03，均早于本次操作）。

### 8.3 回收目录字节数 vs 工程目录减少量

```
PS> (Get-ChildItem D:\Users\陶鑫旺\Documents\LCEDA-Pro\projects -Recurse -File |
       Measure-Object Length -Sum).Sum
150,630,020
PS> (Get-ChildItem F:\cache\eda-trash\20261127-100257 -Recurse -File |
       Where-Object Name -notin "_move-summary.json","_move-log.json","inventory.json","README.txt" |
       Measure-Object Length -Sum).Sum
214,251,410
364,881,430 - 150,630,020 = 214,251,410   vs 回收目录 214,251,410   -> 差 0 B（0.0000%）
```

### 8.4 移动执行结果

```
PS> pwsh -NoProfile -File F:\cache\temp\eda-cleanup\do-move.ps1
LIVE count=253 totalBytes=364881430
PLAN keep=77 move=176 sum=253
TRASH=F:\cache\eda-trash\20261127-100257
MOVED ok=176 failed=0
```

0 失败：没有任何目录因占用/权限被跳过，因此不需要「失败即保留」的兜底分支。

## 9. 交付物与回滚

| 路径 | 说明 |
| --- | --- |
| `F:\cache\eda-trash\20261127-100257\inventory.json` | 全量清单 **253** 条：`{name, mtime, bytes, keep, reason}`，bytes 合计 364,881,430 = 清理前总字节 |
| `F:\cache\eda-trash\20261127-100257\README.txt` | 来源/时间/条目数/恢复命令 |
| `F:\cache\eda-trash\20261127-100257\_move-log.json` | 176 条源→目标→字节→成功标志→移动后实测字节 |
| `F:\cache\eda-trash\20261127-100257\_move-summary.json` | 汇总：前后计数、规则原始命中数、保留集合 |
| `...\pcb-auto\out\_probe\EDA-PROJECT-CLEANUP.md` | 本报告 |

> `pcb-auto\out\` 会被 `run-overnight.ps1` 每 3 轮按「保留最新 40 个 + 每个设计名最新 1 个」清理（见 `pcb-auto\AGENTS.md`），`_probe\` 属于同一棵树。因此**本报告不是唯一副本**：`inventory.json` / `_move-log.json` / `_move-summary.json` / `README.txt` 都在 `F:\cache\eda-trash\20261127-100257\`，本报告若被清理，依据仍可从那四个文件重建。

回滚（目录名原样保留，逐条或整批）：

```powershell
Get-ChildItem -LiteralPath 'F:\cache\eda-trash\20261127-100257' -Directory |
  Move-Item -Destination 'D:\Users\陶鑫旺\Documents\LCEDA-Pro\projects'
```

## 10. 遗留风险 / 未做的事

1. 跨卷 `Move-Item` 是「复制后删除」，不是原子 rename；已逐个校验目标存在且字节一致，无中断项。
2. 保留的 30 个「仅 K4」工程都是 pcb-auto 历史运行的产物，日志里仍引用它们的目录名。若后续确认这些运行已作废，可按 `out\<设计>` 目录为单位成批清理——但那是下一次判断，本次按规则保留。
3. EDA 客户端的「最近打开」列表可能存在失效条目（`database\` 内的记录指向已移走路径）。这只影响首屏列表显示，不影响 `session list` 与工程打开；未修改 `database\`（硬约束 #3）。
4. `example-projects` 5 个官方示例（71,359,232 B）按规则原样保留，未计入本次任何统计口径的「移走」。

