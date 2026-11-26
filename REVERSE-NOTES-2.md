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
