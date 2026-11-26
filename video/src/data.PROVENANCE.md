# `video/src/data.json` 溯源

> 本文件由 `video/scripts/collect-data.mjs` 生成，**不要手改**。
> 要改视频里的数字 = 改生成脚本并重跑，不要直接编辑 JSON —— 手写的数据下次还会腐烂。

## 1. 数据来自哪一次运行

| 项 | 值 |
| --- | --- |
| 运行目录 | `out/ESP32S3_Wireless_Mic_V3-20261126-163653` |
| 设计快照 | `out/ESP32S3_Wireless_Mic_V3-20261126-163653/_design.snapshot.json` |
| 设计文件 | `designs/mic-esp32s3-v3.json` |
| `_run.json` mtime | `2026-11-26T09:09:44.068Z` |
| `_log.json` mtime | `2026-11-26T09:09:44.073Z` |
| 设计快照 mtime | `2026-11-26T08:36:53.913Z` |
| 设计快照 sha256 | `3940d6b6ee0e4917b1065ff6688e046200c5a8fcc018fdb82f642b23bfcb8d37` |
| 设计文件 sha256 | `3940d6b6ee0e4917b1065ff6688e046200c5a8fcc018fdb82f642b23bfcb8d37` |
| `data.json` 生成于 | `2026-11-26T09:30:53.582Z` |
| 日志读自 | `_log.json#entries` |
| 钉住方式 | `PINNED_RUN` —— out/ 下产物齐全（_run.json + _log.json + Gerber.zip）的 run 中 exportsOk 最高、再取最新 |

**复算命令**（唯一让这些数字重新落地的方式）：

```powershell
# 用 PATH 里的 node，不写死作者机器上的绝对路径 —— 这里原来写的是
# 一个写死的 node.exe 全路径，于是生成出来的溯源文档把开发者路径一起发布了，
# 而 test/dev-path-scan.mjs 和 test/smoke.mjs 都会因此判红。
# 复算要的是「跑哪条命令」，不是「在我这台机器上是哪个二进制」。
& node 'video\scripts\collect-data.mjs'
# 校验：
& node -e "const d=require('./video/src/data.json');console.log('keys=',Object.keys(d).join(','))"
```

## 2. 每个数字的出处

同一张表也写在 `data.json` 的 `_provenance.fields` 里（机器可读）。

| 字段 | 出处 |
| --- | --- |
| `generatedAt` | 本脚本运行时 `new Date().toISOString()`（生成时刻，不是流水线测量值） |
| `outName` | `out/` 下的目录名 |
| `outDirRel` | `out/<outName>` |
| `designId` | `designs/` 下设计文件名（去 `.json`） |
| `designName` | `_run.json#designName`（= 设计快照 `#name`） |
| `designFriendly` | 设计快照 `#friendly` |
| `idea` | 设计快照 `#_idea`（= `_run.json#idea`） |
| `components[]` | 设计快照 `#components[].{des,lcsc,value}` |
| `componentCount` | 设计快照 `#components.length` |
| `connectionCount` | 设计快照 `#connections.length` |
| `nets[]` | `_log.json#entries[s=netlist].v[].pins` 去重去空后排序 |
| `netCount` | `nets.length` |
| `board.widthMil` | `_run.json#boardWidthMil`（本次实际生效的板框） |
| `board.heightMil` | `_run.json#boardHeightMil` |
| `board.name` | `_log.json#entries[s=board].v.name` |
| `board.sch` | `_log.json#entries[s=board].v.schName` |
| `drc.passed` | `_run.json#gates.drcPassed` |
| `drc.violations` | `_run.json#gates.drcLeafCount`（叶子层违规组数） |
| `drc.schErrors` | `_run.json#gates.schDrcErrors` |
| `drc.schWarns` | `_log.json#entries[s=schDrc].v.warns` |
| `drc.mismatches` | `_run.json#gates.mismatches` |
| `elapsedMs` | `_run.json#elapsedMs` |
| `elapsedSec` | `elapsedMs / 1000` 保留 1 位小数 |
| `phases[]` | `_log.json#entries[s=PHASE].v` 的 `{n, ms}`；`ms` 是**累计**毫秒，`dur` 为相邻差分 |
| `phaseCount` | `phases.length` |
| `copperPours` | `_log.json#entries[s=copperPours].v.count` |
| `snappedLines` | `_log.json#entries[s=snappedLines].v.snapped` |
| `clearanceFixes` | `_log.json#entries[s=clearanceFixes].v`（数字） |
| `routed` | `_log.json#entries[s=route].v` 的 `{state, ms}` |
| `gerberEntries` | `Gerber.zip` 中央目录记录数（真实解压条目） |
| `artifacts[].bytes` | `out/<run>/<file>` 的 `statSync().size`（不信 log 里的 size） |
| `artifacts[].human` | `bytes / 1024` 保留 1 位 + 单位 |
| `exportsOk` | `_run.json#gates.exportsOk` |
| `exportsTotal` | `_run.json#gates.exportsTotal` |
| `_source` | 同名字段，冗余记录来源目录与设计路径 |
| `_provenance` | 本表 + 三个输入文件的 mtime / sha256（机器可读副本） |

## 3. `data.json` 的 schema（谁读它 / 缺了画面会怎样）

`data.json` 只被 `video/src/scenes.jsx` 读取（`import data from './data.json'`）。
下面是**全部**顶层键，行号指向 `video/src/scenes.jsx` 的真实使用点。

| 字段 | 类型 | 语义 | 读取方 | 缺失时 |
| --- | --- | --- | --- | --- |
| `generatedAt` | string(ISO) | 生成 data.json 的时刻 | 无 | 不影响画面；判断数据新旧 |
| `outName` | string | run 目录名 | scenes.jsx:624,872 | 画面出现 `undefined` |
| `outDirRel` | string | `out/<outName>` | 无 | 无 |
| `designId` | string | designs/ 下设计文件名（去 .json） | scenes.jsx:275 | 原理图页路径缺文件名 |
| `designName` | string | 设计名 | scenes.jsx:871 | 收尾署名缺 |
| `designFriendly` | string | 中文友好名 | 无 | 无 |
| `idea` | string | 需求原文 | scenes.jsx:215 | 开场「一句话」空白 |
| `components[]` | {des,lcsc,value}[] | 器件表（设计值，非实际来料值） | scenes.jsx:321 | 器件页空 |
| `componentCount` | number | 器件数 | scenes.jsx:172,312 | 大数字缺 |
| `connectionCount` | number | 连接数（design.connections） | scenes.jsx:317 | 文案缺 |
| `nets[]` | string[] | 网络名去重排序 | scenes.jsx:377 | 网络页空 |
| `netCount` | number | 网络数 | scenes.jsx:173,372 | 大数字缺 |
| `board` | {widthMil,heightMil,name,sch} | 板框与板名 | 无（仅存档） | 无 |
| `drc` | {passed,violations,schErrors,schWarns,mismatches} | 质量指标 | scenes.jsx:722-724,816,875 | 质量页缺 |
| `elapsedMs` | number | 总耗时毫秒 | 无 | 无 |
| `elapsedSec` | number | 总耗时秒（1 位小数） | scenes.jsx:175,874 | 大数字缺 |
| `phases[]` | {name,cum,dur}[] | 阶段累计 / 单阶段耗时 | scenes.jsx:408-485 | 流水线页空 |
| `phaseCount` | number | 阶段数 | scenes.jsx:174,461 | 大数字缺 |
| `copperPours` | number\|null | 铜皮块数 | scenes.jsx:814 | 显示 null |
| `snappedLines` | number\|null | 走线端点吸附条数 | scenes.jsx:816 | 显示 null |
| `clearanceFixes` | number\|null | 间距修复数 | 无 | 无 |
| `routed` | {state,ms}\|null | 布线状态 / 耗时 | 无 | 无 |
| `gerberEntries` | number | Gerber.zip 内文件数 | scenes.jsx:710 | 文案缺 |
| `artifacts[]` | {file,label,note,bytes,human}[] | 6 个产物（字节数真读磁盘） | scenes.jsx:592-693 | 产物页空 |
| `exportsOk` | number\|null | 导出成功数 | 无 | 无 |
| `exportsTotal` | number\|null | 导出总数 | 无 | 无 |
| `_source` | object | 来源目录（冗余） | 无 | 无 |
| `_provenance` | object | 机器可读溯源（本文件的数据副本） | 无 | 无 |

## 4. 本次 run 的口径（为什么有些数字看着「不好」）

- `_run.json#ok = false`：跑的是「流水线自己跑完了没有」，**不是**「能不能下单」。
  可下单性的唯一权威是 `fabcheck` 的退出码（见 `AGENTS.md` 三条不许）。
- `gates.drcPassed = false`、`gates.drcLeafCount = 33`、
  `gates.drcTotalCount = 66`、`gates.errors = 1`。
  叶子层违规 33 组 / 类别层计数之和 66；
  门禁错误 1 条：["错料 C7(C1651): 设计写 2.2nF，器件实际 2.2pF"]。
- **画面文案与数据不一致（已知，未修）**：`scenes.jsx` 第 814 行的「DRC 全部通过」是
  **硬编码字符串**，不由 `data.json` 驱动，所以它不会跟着 `drc.passed=false` 变。
  这一版数据下它是一句假话。要发布这一版视频，二选一：
  1. 把该行改成读 `data.drc.passed`（改 `scenes.jsx`，属于视频工程改动）；
  2. 换一条 DRC 全过的 run：`VIDEO_RUN=ESP32C3_Minimal-20261126-084735`。
- 两个 `drc` 数字的口径不同：`violations` 是**叶子层**（33），
  `gates.drcTotalCount`（66）是类别层计数之和，**不能**互相替代。

## 5. 缺失字段（本 run 为 null 的项）

无 —— 这次 run 里每个字段都有真实来源，没有一个是编的。

## 6. 不再写入的字段

- `designRaw`：旧版脚本把整份设计 JSON 塞进 `data.json`。没有任何组件读它，
  而一份 13KB 的副本会让「设计改了两处」这种漂移无声无息。设计请直接看 `designs/`。
