# CANVAS-API-RCA（纯只读取证，未启动 LCEDA）

源：`api-types.d.ts`(2,028,656B,0.3.86.fb57d12b) 的签名与 JSDoc；同目录 `api.js`=扩展开箱运行时实现；`cli.js`=CLI 初值。

## 1 两个 API

### 1.1 DMT_EditorControl#getCurrentRenderedAreaImage（类 L529）
L917 `public getCurrentRenderedAreaImage(tabId?: string): Promise<Blob | undefined>;`
JSDoc L896-916 原文：`获取画布渲染区域图像`／`@beta`／`@param tabId - 标签页 ID，如若未传入，则获取最后输入焦点的画布`／`@returns - 画布渲染区域的 Blob 格式图像数据`。
- 无 @internal、无权限注解、无视口尺寸要求；全库 headless 注释仅 5 处（L29627、29652、30245、46816、46832），无一涉及本方法 → headless 行为未文档化。
- 前置条件只有通用约定：L527「编辑器控制基于当前已打开的工程设计下的图页」；L534「打开文档是调用画布 API 的前置条件」；L536「…仅对已打开并激活的文档有效」。即需 openDocument 且已激活（或"最后输入焦点"的画布）。
- 实现只是 RPC 转发（api.js@427596 `rpcCall("extensionApi.DMT_EditorControl.getCurrentRenderedAreaImage",t)`），真身在前端进程，不在 assets 内 →「是否必须有非零视口/可见合成」静态不可证。

### 1.2 SYS_FileSystem#saveFileToFileSystem（类 L46677）
L46842 `public saveFileToFileSystem(uri: string, fileData: File | Blob, fileName?: string): Promise<boolean>;`
JSDoc L46821-46841 原文要点：`@beta`／`注意 1：本接口仅客户端有效，在浏览器环境内调用将始终 throw Error`／`注意 2：本接口需要使用者启用扩展的外部交互权限，如若未启用将始终 throw Error`／`注意 3：CLI 本地文件写入不做路径白名单校验、不受 APP_PROJECT_DIR 限制；uri 结尾带斜杠 /（Windows 为反斜杠 \）识别为目录`／`注意 4：CLI 无头运行内置 eda 扩展时，需在命令后追加 --ext-uuid eda 才能通过外部交互权限校验`／`@param uri 如若结尾为斜杠 /（Windows 为反斜杠 \），则识别为文件夹；如若结尾非斜杠，则识别为完整文件名，此时 fileName 参数将被忽略`／`@returns 写入操作是否成功，如若不允许覆盖但文件已存在、或客户端拒绝写入（路径不在允许范围、目录不存在等）将返回 false`。
实现 api.js@1898326（逐字骨架）：
`if(!this.extensionUuid||!T.loadedExtensionsIsAllowExternalInteractions[this.extensionUuid])throw new Error(_i); … let r=!/\/$/.test(t); if(!r&&!n)return!1; r||(t=t+n); let s=await bM(i); …fetch("app://api/client/writeFileSync?path="+encodeURIComponent(t),{method:"POST",body:s}); … return l===!0||l==="true"`
- 权限标志原文 `isAllowExternalInteractions`；报错串 `_i`＝「错误：未启用扩展和独立脚本的外部交互权限！CLI 无头运行请在命令后追加 --ext-uuid eda 后重试。」（api.js@424551）；cli.js 初值 `loadedExtensionsIsAllowExternalInteractions:{eda:!0}`。
- **目录判定只认正斜杠 `/`**（`/\/$/`），与 JSDoc「Windows 为反斜杠 \」不一致：uri 以 `\` 结尾时按"完整文件名"处理、fileName 被丢弃；拼目录 `t=t+n` 不补分隔符。
- fileData 只接受 File|Blob（`bM`=`readAsDataURL`→取 `,` 后 base64 作 body，api.js@475922/476114）；ArrayBuffer、裸 base64 字符串会抛 TypeError。

## 2 失败条件（按可能性，附依据）
1. **shot() 拿到的是尚未初始化的 fs（最可能）**：`pipeline3.js:105` 调 `fs.saveFileToFileSystem`，唯一声明 `const fs = eda.sys_FileSystem` 在 `:2275`；shot() 全部 9 个调用点（:474/:543/:636/:756/:1043/:1213/:1872/:2081/:2273）都早于 :2275 → TDZ `ReferenceError`（若 esbuild 把 const 降级成 var，则是 undefined 取值），被 :108 的 catch 吞成 `shotErr`。依据：该文件 `fs` 仅 4 处（105/2275/2281/2341），2281/2341 在 2275 之后 —— 与「导出 6 件成功、录制 0 张」的分界完全吻合。
2. **uri 以 `\` 结尾不被识别为目录**：依据 1.2 实现（正则只认 `/`）与 JSDoc L46835-46837。shot 传 `FRAMES+'\\'` → fileName 丢弃、路径落在目录上 → 返回 false。
3. **headless 下无渲染帧**：依据返回类型 `Blob | undefined`(L917) 与 `@beta`(L899)，headless 注释无处涉及此方法；无帧时脚本走 :101 的 `shotNone`。
4. **外部交互权限未启用 → throw**：依据 L46828/L46832 与 `_i` 原文。但同轮 :2281 用「全路径」写法成功写出 6 件产物 → 权限已通，可排除。

## 3 其它能拿像素/导出图的入口（行号=api-types.d.ts）
- `SCH_Document.renderRegion` L30447 `renderRegion(options: ISCH_DocumentRenderRegionOptions): Promise<TSCH_SourceResult<File>>`；L30437 `@recommendedFor cli - 一次调用取回指定区域的图像文件，无需前端截图`；L30195 支持 `png`/`svg`；仅原理图/符号，PCB 无对应。
- `SCH_ManufactureData.getPngFile` L31108 `(fileName?, resolution?: ISCH_ExportPngResolution)`（最大 4096）；`getSvgFile` L31123；`getExportDocumentFile` L31020（@deprecated since 4.1，支持 PDF/PNG）。
- `PCB_ManufactureData.getPdfFile` L13894（PCB 侧唯一"成图"出口，矢量 PDF）；`getGerberFile` L13482；`getDxfFile` L13812；`get3DShellFile` L13554。
- `LIB_Footprint.getRenderImage` L6606、`LIB_Symbol.getRenderImage` L8264（库内封装/符号 PNG Blob，与当前板无关）。
- `PCB_RayTracerEngine.exportImage` L29706 `Promise<Blob|null>`（L29652：headless 可能挂起至超时）；`exportPackage` L29735 `Promise<Blob>`。
- `DMT_EditorControl.openPcb2DPreview` L578 / `openPcb3DPreview` L600（开预览页返回 tabId，不返回像素）。
- `SYS_FileSystem.saveFile` L46806（走下载/Electron 对话框，L46804 `@notRecommendedFor cli`）。
- PCB 侧全库无 PNG/SVG 位图导出方法（PNG 命中的导出方法全在 SCH 侧）。

## 4 结论

最可行：先修静态 bug，不动 API 用法。1) 把 `const fs = eda.sys_FileSystem` 移到脚本顶部（或 shot 内直接用 `eda.sys_FileSystem`）；2) 写盘改全路径 `saveFileToFileSystem(FRAMES+'\\'+name, blob, name)`，与已成功的 :2281 同形，同时绕开目录判定。
若仍 0 张，用最小探针区分「无帧」与「写盘失败」：
`const b=await eda.dmt_EditorControl.getCurrentRenderedAreaImage(); const u=b?new Uint8Array(await b.arrayBuffer()):null; return {b:!!b,size:b&&b.size,type:b&&b.type,png:!!(u&&u[0]===0x89&&u[1]===0x50),len:u?u.length:-1}`
判读：`b:false`→无帧；`len<1000`→空帧；`png:true&&len>10000`→真帧。

base64 结论：**不需要新 API**。扩展沙箱里 `FileReader` 可用（api.js 自己就在用，@475922），`readAsDataURL(blob)` 后 `split(',')[1]` 即 base64 字符串，可安全穿过 JSON 返回或写进 `_run.json`，绕开 saveFileToFileSystem 及其外部交互权限。全库没有"直接返回 base64 图像"的 API，也没有 sys_Clipboard 之类（grep 无命中）。

待证实的点（条件式）：
- 若 `getCurrentRenderedAreaImage` 在 headless 仍产出非空 PNG，则「TDZ 修正 + 全路径写盘」即可出图；用上面探针的 `png:true && len>10000` 证实。
- 若 `FileReader` 与扩展脚本同一 realm，则 base64 路线成立；用一条 `typeof FileReader` 返回 `"function"` 证实。
- 若两者都不成立，PCB 侧唯一剩余出路是 `getPdfFile`(L13894) 出矢量 PDF 后在主机侧栅格化（已不属 EDA API）。

未证实项（不编造）：`mr`（客户端判定）在 headless 的真实取值、前端进程内 getCurrentRenderedAreaImage 的实现、headless WebContents 是否提供 canvas 后端 —— 这些代码不在 assets 内。
