# lceda-pro 4.1.111 CLI 逆向笔记

> 环境：`E:\APP\lceda-pro\lceda-pro.exe`，版本 4.1.111 / 构建 d742969f
> 目标：全自动 PCB 设计（零人工干预）

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

## 7. API 知识库（离线）

`pcb-auto/api/` 下：
- `_index.json` 全量类型索引（584 个类型）
- `classes.csv` / `methods.csv` 108 个可调用类 + 全部方法
- `methods/<Class>.<method>.json` 关键方法详细签名与示例
