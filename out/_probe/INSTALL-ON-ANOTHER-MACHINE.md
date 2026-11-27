# 把 pcb-auto 装到另一台机器：装得起来，但一开始画不出板

> 实测 2026-11-27 12:41–13:40（Asia/Shanghai）
> 通道：RelayDesk/flix `shell 192.168.237.200:18991`（DESKTOP-K087HI9 / Administrator / Win11 专业版）
> 目标：装上 → 让它画一模一样的板 → 看有没有问题

## 一、对端条件（够用，且 LCEDA 版本正好对）

| 项 | 实测 |
|---|---|
| LCEDA | `D:\APP\lceda-pro\lceda-pro.exe`，**4.1.111**（正是本项目唯一支持的版本），212.7 MB |
| pwsh | `C:\Program Files\PowerShell\7\pwsh.exe` 有 |
| node / python / git | v24.22.1 / 3.13.12 / 2.53.0 |
| GitHub 直连 | 200 |
| D 盘 / C 盘 | 809.4 GB / 86.1 GB |
| 管理员 | 是 |

## 二、装的过程里撞到三个问题

### 问题 1：对端也没有 WMIC ⇒ EDA 起不了服务端（已知坑，文档里就有）

```
{"ok":false,"error":{"code":"SPAWN_OWNER_FAILED","message":"Failed to spawn the server copy:
  spawn C:\windows\System32\wbem\WMIC.exe ENOENT (start the client manually and retry...)"}}
```

和本机一模一样（见 `EDA-SESSION-DEADLOCK.md`）。按那份文档的恢复流程处理即可：
`Start-Process lceda-pro.exe` → 等 25 s → `open --headless true` → 把 sid 写进 `.session`。
**这条已经写在文档里，但它是「装完第一步就会炸」的等级**，应该进安装说明。

### 问题 2：契约检查在全新克隆上**永远跳过**（真缺陷，已修）

```
staticcheck exit=2  「解析器不可用（acorn=false eslint-scope=false），本关跳过」
run-all：「契约检查跳过（检查器环境不可用，exit 2）：本次未核对返回契约」
```

根因：根 `package.json` **一个依赖都没声明**，而 `scripts/staticcheck.js` 是从
`video/node_modules` 借 `acorn` / `eslint-scope` 的 —— 那是我装 Remotion 的副产品。
所以「返回对象引用了不可见标识符」这一类闸门（能让整轮十几分钟白跑）
**在任何只做过 `git clone` 的机器上都是关闭的**。

修法（`3c155c0`）：把它俩声明成 `devDependencies`。运行时仍零依赖。

### 问题 3：导出的六个文件全部「有大小但没落盘」（真缺陷，已修两次）

把仓库装在 `D:\projects\pcb-auto` 时，整轮跑满 355 秒，产物目录里**只有 PowerShell 写的三个文件**，
而 `exports` 里六项都带着**真实大小**：

```
[{"name":"Gerber.zip","ok":false,"size":113614},{"name":"Board.pdf","ok":false,"size":773881}, ...]
```

`ok:false` 是因为 `ex()` 的判据是 `saveFileToFileSystem()` 的返回值；而 `size` 是 `blob.size`
—— 数据拿到了，只是写不进去。**于是「写盘失败」被报成了「设计未通过」。**

逐位定位（同一个 API 写四个位置）：

| 目标 | 返回 |
|---|---|
| `C:\Users\Administrator\Documents\_probe_fs\a.bin` | **true** |
| `C:\Users\Administrator\Documents\_probe_fs2.bin` | **true** |
| `D:\projects\pcb-auto\out\_probe.bin` | **false** |
| `C:\Users\...\AppData\Local\Temp\_probe.bin` | **false**（本机同样 false） |

**`eda.sys_FileSystem.saveFileToFileSystem` 只允许写 Documents 目录下。** 这条限制不在任何文档里。

修法两步：
1. `f20c0e9` —— 开工前写一个 2 字节探针到 outDir，写不进就压进 `envFaults` 并提前返回。
2. `286725b` + `dc0d5d4` —— 让 run-all 按环境故障报（而不是「DRC 违规组 0」）并停阶梯。

第 2 步里我先踩了个自己的坑：早退路径把原因放在**顶层 `envFaults`（数组）**，
而 run-all 读**顶层 `envFaultList`**，正常路径则放在 **`gates.envFaultList`** ——
三个形状两种键名，于是分支**从来没触发过**。这类缺陷不报错，表现是「新加的分支永远走不到」。

## 三、修完之后的对比

仓库移到 `C:\Users\Administrator\Documents\pcb-auto` 后（`git pull` 到 `f20c0e9`）：

```
exports 6/6，产物 15 个文件：
  Gerber.zip 113640 / BOM.xlsx 8026 / PnP.csv 12176 / Netlist.json 69824
  TestPoints.xlsx 8505 / Board.pdf 773881
  _run.json / _log.json / _log-1-smart-fit.json / _log-2-expand-1.25x.json / ...
```

**结论：不是机器差异，是仓库位置。**

## 四、与本地同设计四次运行对照

| 运行 | 机器 | 板宽 | ok | DRC 叶子 | exports | 耗时 |
|---|---|---|---|---|---|---|
| -222113 | 本地 | 1300 | true | **0** | 6/6 | 362 s |
| -231945 | 本地 | 1300 | true | **0** | 6/6 | 456 s |
| -005256 | 本地 | 1300 | true | **0** | 6/6 | 410 s |
| -115941 | 本地 | **1625** | false | **7** | 6/6 | 356 s |
| remote | 对端 | **1625** | false | **7** | 6/6 | 327 s |

对端与本地那次 7 条叶子的**组成逐项相同**：

```
SMD Pad to Track=2; SMD Pad to Via=2; Slot Region to Track=1; Hole to Hole=2
```

所以对端复现出来的是「**加宽到 1625 之后的结果**」，不是「另一台机器算得不一样」。
两台的差异在别处：对端 `routeState=TIMEOUT`，本地那次 `completed`。

### 顺便修正我上一轮的说法

我上次说「绿不可复现」，把它写成了随机的。实测更准确的说法是：
**attempt 1 在 1300 宽上有 3/4 通过、1/4 不通过；不通过就加宽到 1625，而 1625 稳定给出 7 条叶子。**
所以「7 条」不是随机数，是**加宽那条路的确定性后果**——这也正对上项目自己记录的
「重试阶梯会让结果变差」。

## 四之二、第四个问题：中文版 Windows 上子进程 JSON 解析不了（已修）

对端长期报「下单资格（诊断用）未取得：fabcheck exit=0，输出不是 JSON」，
而 `fabcheck` 直跑完全正常（13619 字、exit 0、stderr 为空）。造了一个普通的假象：
“量具坏了”。真因是编码：

```
对端 pwsh 7.6.10   [Console]::OutputEncoding = gb2312/936（chcp 936）
本机 pwsh 7.7.0    [Console]::OutputEncoding = utf-8/65001
```

GBK 控制台把子进程的 UTF-8 中文错误解码，`ConvertFrom-Json` 报：

```
After parsing a value an unexpected character was encountered: b.
Path 'summary.line', line 21, position 3.
```

`summary.line` 是 JSON 里第一个含中文的字段（`可打样：0 阻断 / 4 项警告`）。

修法（`3915534`）：run-all.ps1 在参数块之后立刻把
`[Console]::OutputEncoding` / `$OutputEncoding` 切到 UTF-8 并设 `PYTHONIOENCODING=utf-8`。

**为什么这个缺陷值得单独记**：中文版 Windows 的默认代码页就是 936，
也就是说——**嘉立创 EDA 的主要用户群默认命中**；而作者机器恰好是 UTF-8，
所以它在本机永远复现不出来。

验证：修后对端完整构建报 `下单资格（诊断用）exit=0 verdict=PASS 阻断 0 / 警告 4`。
新增 `test/console-encoding-gate.mjs`（第 18 关），双向证明：注掉那两行 → FAIL 3/6、exit 1；
还原 → PASS 6/6、exit 0、逐字节复原。

> 自己踩的坑：闸门第一版把正则写成匹配子串，于是把目标行**注释掉**之后闸门照样全绿
> （`# [Console]::OutputEncoding = …` 里仍含那个子串）。已改成行首锚定 + `(?!#)` 排除注释。
> **只匹配子串、不管是否生效的断言，是另一种假绿。**

## 六、最终：对端跑通了（2026-11-27 16:06–16:14）

代码 `7ebba6d`（含编码修复、退出码三态、布线变体排序），仓库在
`C:\Users\Administrator\Documents\pcb-auto`：

| 项 | 结果 |
|---|---|
| `ok` | **True** |
| DRC 叶子 / 总数 | **0 / 0** |
| exports | **6/6** |
| routeState | completed |
| 耗时 | 336.8 s（smart-fit 一次过） |
| 独立 DRC 复核 | 通过 |
| 独立校验 | **19 通过 / 0 失败 / 0 备注** |
| `_gates.independent.json` | `finalOk:true` / `exitCode:0` / 「六道独立闸门都测过且通过」 |
| 产物 | 16 个（Gerber 111229 / Board.pdf 801150 / BOM / PnP / Netlist / TestPoints + 3 份交付文档） |

**与本机一致的地方**：宽 1300 时 0 叶子、路径上那次 1625 宽才出 7 叶子 —— 两台机器现在给出同一个结果。

同一台机器上的全部 21 道闸门也全绿（`npm test` exit 0）—— 闸门是可移植的。

## 七、回馈到项目里的改动

七个问题里四个只有装完才知道，这不该靠读文档发现。所以它们变成了一条命令：

```
npm run doctor        # scripts/preflight.mjs
```

检查 10 项，区分阻塞与提醒（0 可跑 / 1 有阻塞 / 2 检查器跑不起来）。
**在出问题的那台机器上实测过**：`PREFLIGHT=OK 8 项通过 / 2 个提醒`（提醒正是
那机的真实情况：没 WMIC 与 gb2312 控制台）。

另修了一个漂移点：我第一版 preflight 自己写了一份 LCEDA 候选路径，与
`scripts/tool-paths.ps1` 的 `Resolve-LcedaCli` 不是同一份（后者还认 `LCEDA_PRO_EXE`、
多三个安装位置）。两份清单漂开的表现是「doctor 说没装、但流水线跑得好好的」
—— 最坏的那种假警。现在直接叫那份唯一实现。

## 八、还留着的两个问题（未修）

1. ~~`fabcheck exit=0，输出不是 JSON`~~（已修，见四之二）：：对端 run-all 多次报这个。本地正常。
   抗审者早就指出过 `fabcheck` 把 FAIL 报告写 stderr、包装器只读 stdout 的错配，
   这次在另一台机器上更明显。需要单独查。
2. **`_log.json` 在对端 outDir 不在 Documents 时写不出来**：因为遥测文件的落盘走的也是
   那个被限制的 API。探针修好后这变成「开工即停」，不会再有半截产物，但**遥测缺失本身**
   仍没有独立的落盘通道。

## 六、可复用的判断

- **「装得上」不等于「跑得通」**：三个问题里两个只在**新机器**上出现（依赖没声明、
  仓库不在 Documents），本机永远复现不了。
- **一个 API 返回 `false` 却同时给出真实 `size`**，是最容易骗过人的组合：数据都在，
  只有落盘失败，而失败标志是一个布尔。
- **加诊断的时候，字段形状必须与已有路径对齐**（键名 / 嵌套层）。否则新分支永远不会触发，
  而语法检查、静态检查、迭代都会通过。
- `git show <rev>:<path>` 的 path **必须是正斜杠**：反斜杠返回空且退出码为 0，
  于是一次「取错输入」变成一次「巨大但看起来成功的偏移」（本次把行号推了 5504，已复原）。
