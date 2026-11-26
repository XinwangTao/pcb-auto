# lceda-pro CLI 逆向笔记（4.1.111）

> 环境：`lceda-pro.exe`，版本 **4.1.111** / 构建 `d742969f`
> 目标：让程序（含 AI Agent）**完全无人干预**地从一句中文想法走到一份可下单的制造文件

这份笔记是这个项目能存在的前提。它记录的是**怎么让一个只有 GUI 的 EDA 软件变成可被脚本驱动的服务** —— 包括那些文档里没写、报错信息会把你带到错误方向的地方。

如果你也在做类似的事（自动化别的 EDA / CAD / 有 GUI 的工程软件），下面「0. 铁律」这一节的形状可以直接照搬：**每一条都是花了几个小时换来的，而且没写下来的话下一个人还要再花几个小时。**

---

## 0. 铁律（踩过的坑）

| 坑 | 现象 | 正确做法 |
|---|---|---|
| PowerShell 抓不到 stdout | `$x = & lceda-pro --help` 得到空 | 用 `\| Out-String` 或重定向到文件 |
| 写文件静默失败 | `saveFileToFileSystem` 返回 falsy、无异常 | **必须加 `--ext-uuid eda`** |
| `saveFile` 不可用 | 会弹出保存对话框 | CLI 里用 `saveFileToFileSystem(uri, blob)` |
| 无头模式文档未激活 | `pcb_Net.getAllNetsName()` 返回 `[]` | 先 `dmt_EditorControl.openDocument(uuid)` + `waitForDocumentReady` |
| 工程树异步 | 建完文档立刻读得到旧数据 | 先 `dmt_Project.waitForReady(uuid, timeout)` |
| 工程建完是空的 | `createProject` 不初始化任何文档 | 必须显式 createSchematic / createPcb / createBoard |

## 1. 命令行总览

```
lceda-pro <command> [options]
  activate         聚焦服务窗口
  open             打开工程 → 返回 sessionId；.eprj3 双向同步
  stop             优雅停止服务
  doctor           探测服务身份
  session/  list | close | abort
  invoke           在编辑器命令空间跑 JS（核心能力）
  functions        列扩展
  doc/  api | external | format    渐进式查 API
  mode/  query | switch            离线/半离线运行时切换（新增）
  config/ query | set              工程/库目录白名单，落 config.json（新增）
全局：--help  --search <q>  --mcp stdio|http
```

## 2. invoke 用法

```
lceda-pro invoke --session <sid> --ext-uuid eda \
  --code-file a.js --timeout 600000
```
- `--code` 直接给源码（≤32KB）
- `--code-file` 读文件（大脚本必须用这个；`-` 表示 stdin）
- 代码体是 **async 函数体**，`return` 即结果；参数从 `__CLI__.args` 取
- `ok:true` 只代表代码跑完，不代表业务成功 → 必须自己 throw 校验

## 3. Source API（首选，比画布层快）

`eda.sch_SourceDocument` / `sch_SourcePrimitive*` / `sch_SourcePin`
- 直接操作工程源数据，**不需要前端已打开图页**
- 强制异步落盘：返回值 ≠ 已落盘；紧接着读可能读到旧数据
- 画图规范：优先用导线（不用网络标签）；未用引脚必须显式 setNoConnect

## 4. 器件选型（关键发现）

- ❌ `lib_Device.batchSearchDevices` — **4.1.111 有 bug**：`result.lists is not an array`，不可用
- ✅ `lib_Device.getByLcscIds(['C1523', ...])` — 按 C 编号精确取，返回最全（符号/封装/3D/分类/描述）
- ✅ `lib_Device.searchByProperties({supplierId:'C1523'})` — 精确检索
- ⚠️ `lib_Device.search('10k 0402')` — 模糊搜索**质量差**，会命中 `C99000xxxx` 社区伪编号，别用
- 关键字段：`otherProperty['Supplier Part']`=LCSC编号，`['JLCPCB Part Class']`=`Basic Part`/`Extended`
- 器件 `uuid` → 放置时用；`symbolUuid` / `footprintUuid` 各自独立

## 5. 生产资料导出

- `pcb_ManufactureData.getGerberFile(name)` → File，15 个文件（含飞针测试 JSON）
- `getBomFile` → xlsx（魔数 `50 4B`，不是 CSV！）
- `getPickAndPlaceFile(name,'csv','mm')` → UTF-16LE + TAB 分隔（魔数 `FF FE`）
- `pcb_Net.getNetlist()` → JSON 字符串
- 落盘统一 `sys_FileSystem.saveFileToFileSystem(dir + '\\file', blob)`

## 6. DRC

- `pcb_Drc.check(strict=true, userInterface=false, includeVerboseError=false)` → 布尔门禁
- `check(true,false,true)` → 分组树（顶层是**类别数**不是错误数）
- `pcb_Drc.getDrcResult()` → 4.1.93 新增，读最近一次结果，有 `state/totalCount/violations/checkedAt`

### 返回的是**嵌套**的，不是平的

`check(true,false,true)` 返回 `[{name, count, list}, ...]`，而 `list` 里还可能有 `list`。所以「有多少条违规」必须自己递归：

```js
const walk = (arr, out = []) => {
  for (const n of arr) {
    if (Array.isArray(n.list) && n.list.length) walk(n.list, out)
    else out.push(n)
  }
  return out
}
```

**没有违规时返回的是空数组**，不是 `null`，也不是 `{count: 0}`。`null` 意味着调用失败，别把两者当成一回事。

### ⚠️ 有一个 `checkDetailed` 从没被用过

`api/classes/PCB_Drc.json` 里确实有：

```
checkDetailed   执行 DRC 检查并返回展平明细
```

`check` 返回嵌套树、`checkDetailed` 返回**展平**明细 —— 如果它真如注释所说是平的，那上面那段 `walk()` 完全没必要。但这个项目**一次都没调用过它**（`grep checkDetailed` 在 `scripts/` 里零命中）。

我没用它，不是因为试过不行，而是因为在发现它之前 `walk()` 已经跑通了，而 DRC 是判定闸门，改它要重新验证整条链。**这是一个已知的、未被采纳的简化机会** —— 写在这里而不是偷偷留着，因为如果你在做同一件事，它可能帮你省掉一整个递归函数。

### 单位陷阱：画布单位 = mil / 10

`minDistance` · `clearance` · `position` 用的都是**画布单位**，要乘 10 才是 mil。仓库内的直接证据：

```js
// scripts/.patch-holenum.js:16
const needDist = Number(e.clearance) * 10;      // 画布单位 mil/10 → mil
```

所以「8 mil 安全间距」要写成 `80`。写成 `8` 不会报错，只会让 DRC 放行 0.8 mil 的间距 —— 一个能下单但一焊就短路的设计。

## 7. API 知识库（离线）

`api/` 下：见 §11 的精确清点。

## 8. 自动布局 / 自动布线（全自动闭环的核心）

位置：`eda.pcb_Document`

### 布线
- `autoRouting(props?)` — 阻塞，**内部 900 秒硬上限**，CLI 的 `--timeout` 无法覆盖 → **不要用**
- `startAutoRouting(props?)` → `{jobId}` 作业模型，**CLI 首选**
- `getAutoJobStatus(jobId)` → `{state, progress, ...}`；`completed` 才提交几何
- `getAutoJobLog(jobId)` / `cancelAutoJob(jobId)`
- **取消或超时 = 已算几何全丢**，必须轮询到 `completed`

### 极速引擎（强烈推荐）
```js
await eda.pcb_Document.startAutoRouting({
  optimization: EPCB_AutoRoutingOptimization.ULTRA_FAST,
  existingPrimitiveMode: EPCB_AutoRoutingExistingPrimitiveMode.REMOVE,
  engineConfig: {
    layers: [{ id: 1, dir: 'V' }, { id: 2, dir: 'H' }],  // 数组！不是对象
    classes: [{ name: 'PWR', nets: ['VCC','VBUS'], width: 20, priority: 20 }],
    pairClasses: [{ pairs: ['USB_D+'], layers: [1,2] }],
  },
});
```
- `ULTRA_FAST` 只走作业模型；直接传给 `autoRouting` 会抛 `INVALID_PARAM`
- 极速引擎**忽略** `RoutingNets` / `cornerStyle` / `layers` / `ignoreNets`，网络范围靠 `engineConfig.classes` / `skipNets`
- 单位 **mil**
- `layers[].id` 必须是数字；`engineConfig.layers` 必须是数组
- 常规引擎的 `props.layers` 必须传启用层（`layerStatus !== NOT_USED`），停用层静默忽略

### 布局
- `autoLayout()` 阻塞无进度 → 用 `startAutoLayout()` 拿 jobId
- `startAutoLayout()` / `getAutoJobStatus` / `cancelAutoJob` 同一套作业模型

### 前置条件（关键）
- 自动布线作用于**当前激活**的 PCB 文档 → 必须先 `dmt_EditorControl.openDocument(pcbUuid)` + `waitForDocumentReady`
- 未激活时：旧内核停在 fan-out 不动；新内核直接抛 `DOCUMENT_NOT_ACTIVE`

### 其他
- `fanout(options)` — 批量扇出过孔与引出线（4.1.93 新增）
- `clearRouting()` — 清空布线
- `importAutoRouteJsonFile` / `importAutoRouteSesFile` / `importAutoLayoutJsonFile` — 导入外部结果
- `getCalculatingRatlineStatus` / `startCalculatingRatline` / `stopCalculatingRatline` — 飞线计算

### 从原理图导入到 PCB
```js
await eda.pcb_Document.importChanges(undefined, true);  // force=true 跳过所有弹窗
```
- `importChanges(uuid?, force?)`；`force=true` 时自动全量导入并等完成才返回
- 游离 PCB（无关联原理图）返回 `false`

## 9. 画布 API 前置条件总结

| 类别 | 是否需打开文档 |
|---|---|
| `sch_Source*` / `sch_SourcePin` | ❌ 不需要 |
| `sch_Primitive*` / `sch_Netlist` / `sch_Drc` | ✅ 需 openDocument(图页 uuid) |
| `pcb_Primitive*` / `pcb_Net` / `pcb_Drc` / `pcb_Document` | ✅ 需 openDocument(pcb uuid) |
| `dmt_*`（工程树） | ❌ 不需要（但要 openProject） |

---

## 10. 不存在的 API（别去试）

一个被幻觉出来的方法名最贵的地方在于：它**不报错**，只返回 `undefined`，然后你在三百行后才发现几何没生效。所以这一节把「查过、没有」也写下来。

在 4.1.111 的 `api/methods.csv`（793 个方法）和 `api/_index.json`（584 个类型）里**都查不到**以下名字：

`setActiveLayer` · `setCurrentLayer` · `showLayer` · `setPointActiveLayer` · `flipBoard` · `setDisplayMode` · `setView` · `getState_Outline` · `getState_Points` · `getPoints` · `getVertex*`

**反例，别照抄错结论**：`getBBox` **是存在的**，但它在 `SYS_Math` 上（`sys_Math.getBBox(polygon)` → 多边形最小外接矩形），**不在** `pcb_Primitive*` 上。`eda.pcb_PrimitivePad.getBBox()` 依然不存在。这一条我一开始记成了「getBBox 不存在」，是被 `methods.csv` 打回来的 —— 所以下面 §12 给了自查命令，别信我的记忆，信查询结果。

### 坐标系（这条最坑）

- `getSource()` 返回的是 **SVG 坐标**（y 向下），其余一切（放置、DRC、导出）是**笛卡尔坐标**（y 向上）
- 换算式：`y_cart = -y_svg`
- 把两者混用不会报错，只会让器件出现在板子外面

### `EPCB_LayerId` 的取值（部分经核实）

| 名字 | 值 | 核实状态 |
|---|---|---|
| `BOARD_OUTLINE` | 11 | ✅ 仓库内 `scripts/s5-pcb-import.js:40` 有注释佐证 |
| `TOP` | 1 | ⚠️ 实测值，本仓库里没有可 `grep` 到的定义 |
| `BOTTOM` | 2 | ⚠️ 同上 |
| `MULTI` | 12 | ⚠️ 同上 |
| `HOLE` | 47 | ⚠️ 同上 |

**为什么大部分是「实测」而不是「查证」**：`EPCB_LayerId` 出现在 `api/_index.json` 的 `value.types` 里（枚举确实存在），但 `api/` 里没有它的取值表 —— 枚举值需要运行时读。所以别把我的表当权威，自己读一次：

```js
// 在 invoke 里跑
return (await eda.pcb_Layer.getAllLayers()).map(l => ({ id: l.id, name: l.name }));
```

（`pcb_Layer.getAllLayers` 是 `api/classes/PCB_Layer.json` 里确实存在的方法，`visibility: beta`。）

「Slot Region」不是独立图层，是 `MULTI`(12) 上的 FILL —— 这一句同样依赖上面的 12，请连同一起核实。

### DRC 的单位陷阱

`minDistance` · `clearance` · `position` 用的是**画布单位 = mil / 10**。所以「8 mil 安全间距」要写成 `80`。写成 `8` 不会报错，只会让 DRC 放行 0.8 mil 的间距。

---

## 11. 离线 API 知识库的精确清点

`api/` 目录是全部入库的（可直接在 GitHub 上浏览），数字如下 —— 都是 `Get-ChildItem` / 行数直接数出来的，可以自己复核：

| 文件 | 内容 | 精确数字 |
|---|---|---|
| `api/_index.json` | CLI 信封 `{ok, value, logs, durationMs}`；真正的索引在 `value.types` | **584 个类型**（类/接口/枚举/type 混在同一入口） |
| `api/_index.json` → `value.callConventions` | 调用约定：`entry` / `classToProperty` / `asyncConvention` / `externalAsyncConvention` / `sourceApiConvention` / `schematicDrawingConvention` 等 | 11 个键 |
| `api/classes.csv` | 每个可调用类：`class, callPath, title, remarks, methodCount` | **108 个类** |
| `api/classes/*.json` | 每个类的完整文档（一个文件一个类） | **108 个文件** |
| `api/methods.csv` | 每个方法：`class, callPath, method, visibility, comment` | **793 行** |
| `api/methods/*.json` | 手挑的关键方法详细签名 + 示例 | 10 个 |
| `api/_classes.txt` | 类名清单 | 108 行 |

合计 0.27 MB。这份东西的价值在于：**它是离线的**。你不需要联 LCEDA 的服务、不需要截图、不需要问客服，`grep` 一下就知道一个方法存不存在、参数是什么。

## 12. 怎么自己复核这份笔记里的每条结论

全都只读，不需要装 LCEDA：

```bash
# 一个方法/类型存不存在
node -e "const t=require('./api/_index.json').value.types.map(x=>x.name);console.log(t.includes('EPCB_LayerId'))"
grep -i 'getBBox' api/methods.csv

# 某个类有哪些方法
grep '^"PCB_Drc"' api/methods.csv

# 某个类的完整文档
node -e "console.log(JSON.stringify(require('./api/classes/PCB_Drc.json'),null,2))"
```

如果某天 LCEDA 换了版本，把 `api/` 重新抓一遍再比，就能知道有没有 API 变了。**这份笔记的有效期 = 版本号 4.1.111**。

## 13. 本文的边界

**这里没有**：

- 怎么装 LCEDA Pro、怎么开它的 CLI 服务（那是安装问题，不是 API 问题）
- 器件库、封装库的内容与质量（那是选型问题，见 `docs/FAILURES.md`）
- 具体某块板子的设计（见 `designs/` 与 `out/`）
- 「怎么设计一块好 PCB」—— 这是工程判断，本文只讲**怎么用程序去驱动这个软件**

**这里有意为之的省略**：凡是 `api/` 里能查到的，本文不重复抄。抄一份就会有一个会过期的副本，然后就会出现「笔记说 A、软件做 B」。本文只写 **`api/` 里查不到的**：踩过的坑、静默失败、顺序依赖、单位陷阱，以及那些「查过、确实没有」的方法名。
