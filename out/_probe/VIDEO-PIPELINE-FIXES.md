# 录视频这条链路上的三个坑（都实测过，会再踩）

> 记录时间：2026-11-27 01:2x–01:4x（Asia/Shanghai）
> 目标：把「最近一次真实构建」的画布帧拍成一条竖版短片。
> 成片：`video/out/v11-final.mp4`（1080×1920 / 30fps / 546 帧 / 18.2 s / 11.4 MB，带 BGM）
> 一条命令：`pwsh -NoProfile -File video\scripts\make-v11.ps1 -Batch 005256`

## 一、帧只在开了录制时才有，而且只有 10 个里程碑 + 若干 route 帧

`run-all.ps1 -Record`（或仓库根的 `.record-on` 哨兵文件）才会让流水线在里程碑调
`eda.dmt_EditorControl.getCurrentRenderedAreaImage()`，把 EDA **自己渲染的画布**落到
`out/frames/<HHmmss>/<尝试>/*.png`。不带 `-Record` 就是 0 张帧，视频只剩占位图。

实测一批（`005256/1-smart-fit`）共 **17 张**：

| 帧 | 字节 | 说明 |
|---|---|---|
| `0000-sch-wired.png` | **13109** | **空画布**（原理图那一枪在器件落位前拍的） |
| `0001..0003` | 84/69/72 KB | pcb-imported / pcb-layout / pcb-pour |
| `0004..0010-route2-t6s..t56s` | 69009 ×6 + 70138 | 7 张里 **6 张字节完全相同**（画布没变就又落了一帧） |
| `0011..0016` | 60–70 KB | routed / bottom / stitched / clearance / patched / drc |

两类「看起来正常、其实没用」的帧：空画布 + 字节重复。所以 `build-v11.mjs` 有两条硬断言：
**空画布**用相对判据（`字节 < 候选中位数/4`，实测 13109 < 17252；绝对阈值换分辨率就失效），
**重复**按 sha256 在段内去重、跨段若整段都重复则整段丢掉。

## 二、Chrome 起不来：`Timed out ... Chrome logged the following:` 后面是空的

Remotion 报的是 25 秒连不上浏览器，而「Chrome 的日志」一行都没有。逐项测下来：
Node 以 `stdio:pipe` 启动 `chrome-headless-shell` **stdout/stderr 都是 0 字节且不退出**。

**根因是 crashpad。** 只加这两个 flag 就能正常截图（实测图片落盘）：

```
--disable-breakpad  --disable-crash-reporter
```

`--single-process` / `--use-gl=swiftshader` / `--no-sandbox` 都不是关键。

Remotion 没有传自定义 chrome 参数的 CLI 开关，所以改的是它的参数表
`video/node_modules/@remotion/renderer/dist/open-browser.js`（在 `'--no-sandbox',` 之后插入两行）：

- 改前 `sha256_12 = 701C776F919D`，改后 `689521011E33`
- **这是改 node_modules**，`pnpm/npm install` 之后会丢，要重打；文件里有注释说明原因。

只改这个还是偶发连不上（约 1/3 概率），所以 `make-v11.ps1` 里带 4 次重试 + 每次先清残留
`chrome*` 进程。有重试之后 4 次里基本 1 次成功。

## 三、本机 Remotion 只出 `yuvj420p / pc`，而混音脚本要 `yuv420p / tv`

`video/mix-and-ship.ps1` 的成片硬规格是 `yuv420p` + `color_range=tv`，且它 `-c:v copy`
直通、改不了，所以不合规直接退 3。而实测：

| 文件 | pix_fmt | color_range |
|---|---|---|
| `v10-195113-v5.mp4`（**已验收的 v10 成片**） | yuvj420p | pc |
| `v11` 三次渲染（含显式 `--pixel-format=yuv420p`） | yuvj420p | pc |

也就是说**这条前置条件本项目从来没满足过**。解法是在中间加一次合法范围映射，不是改判据：

```powershell
ffmpeg -i in.mp4 -vf "scale=in_range=pc:out_range=tv,format=yuv420p" `
  -c:v libx264 -preset slow -crf 14 -pix_fmt yuv420p `
  -color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709 `
  -c:a copy -movflags +faststart out.mp4
```

`scale=in_range=pc:out_range=tv` 是关键：直接 `-pix_fmt yuv420p` 会把 pc 当 tv 解释，
画面发灰。转换后 ffprobe 实测 `yuv420p,tv`，混音脚本一次通过（−21.6 LUFS，配方预期约 −21.1）。

## 四、踩在自己身上的两个错（都是「看着对、跑起来才炸」）

1. **`tag: c.beat.tag || c.beat.tagPrefix`** —— `tagPrefix` 是 **RegExp**，`JSON.stringify`
   把它变成 `{}`，组件又把 `frame.tag` 当 React 子节点渲染 ⇒
   `Minified React error #31 ... object with keys {}`，而报错点是**第 201 帧**（第 3 段起点），
   两件事看起来毫不相干。修法：tag 一律从文件名解析成字符串，并加断言。
2. **读错了 `_run.json` 的位置** —— DRC 计数在 `gates.drcLeafCount` 里，不在顶层。
   读错的后果不是报错，是成片里打出一行「DRC 未过 null/null 组」——**看起来像测量结果**。
   同理组件末尾读的是 `run.elapsedS`（秒），少写就是一行 `undefineds`。

## 五、复核命令

```powershell
# 成片规格（必须 yuv420p / tv / 1080x1920 / 30fps）
ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate,nb_frames,pix_fmt,color_range -show_entries format=duration,size -of default=noprint_wrappers=1 video\out\v11-final.mp4

# 抽一帧看事实条有没有 null/undefined
ffmpeg -v error -y -i video\out\v11-final.mp4 -vf "select=eq(n\,470)" -vframes 1 F:\cache\temp\check.png

# 段表与挑帧报告
node video\scripts\build-v11.mjs --batch 005256 --dry
```
