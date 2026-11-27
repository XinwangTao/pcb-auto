# PCB Auto · 插件详情

把 pcb-auto 流水线暴露成 5 个模型可调用的工具。**插件不重写流水线** —— 它只是给一套已经跑过 83 轮无人值守的
PowerShell/Node/Python 脚本加上类型化的工具接口。重写会漂移出「发布数字所基于的那套代码」。

## 五个工具

| 工具 | 输入 | 输出 | 耗时 |
|---|---|---|---|
| `pcb_idea_to_design` | 一句中文想法 | 设计 JSON（确定性：同一句想法字节相同） | ~1 s |
| `pcb_build` | 设计 JSON 路径 | 产物目录 + 闸门摘要 | **2–20 min** |
| `pcb_fabcheck` | 产物目录 | 能不能下单（退出码 0/1/2） | ~0.3 s |
| `pcb_census` | 可选 `settle` 秒 | 全语料通过率 | ~20 s |
| `pcb_verify` | 可选 `skipCensus` | 交付一致性判定 | ~6–17 s |

## 三条设计承诺

**1. 非零退出码是结果，不是异常。**
`pcb_fabcheck` 退出码 1 表示「有阻断」—— 这是一个**合法答案**，模型必须能读到它，而不是收到一个
`Command failed: exit 1` 的异常。所以插件的每个 `execute` 都把 `code` 当作数据返回。

**2. 每个工具都返回有界输出 + 完整日志路径。**
没有一个工具会 dump 200 KB 文本。`pcb_build` 最多回 800 字摘要，完整内容在 `_run.json` 和
`logs\fail-*.txt` 里。截断时明确写「已截断 N 字符」。

**3. 长跑服从 `exec.signal`。**
一次 `pcb_build` 最坏 45 分钟。用户点取消时，子进程必须真的被杀掉，而不是留在后台继续画板子。

## 配置

```yaml
- id: pcb-auto
  name: '@pcb-auto/dsh-plugin'
  config:
    root: 'D:/path/to/pcb-auto'   # 必填：插件不知道仓库在哪
    # pwsh: 'pwsh'
    # node: 'C:/Program Files/nodejs/node.exe'
    # python: 'C:/.../python.exe'
    # timeoutMs: 2700000
```

`root` 是**唯一必填项**。其余都有可靠默认：`node` 默认是运行插件的解释器，
`python` 会去找 DSH 自带的 runtime，`pwsh` 走 PATH。

## 一条重要的口径警告

**判断「这块板能不能下单」只能用 `pcb_fabcheck` 的退出码，不能用 `_run.json.ok`。**

这两个字段含义不同：`_run.json.ok` 说的是「流水线这次自己跑完了没有」，
`fabcheck` 说的是「这些文件能不能直接拿去打样」。

实测这 56 个目录的四格分歧表（2026-11-26 10:08，settle=180）：

| | fabcheck 可下单 | fabcheck 阻断 |
|---|---|---|
| `_run.json.ok = true` | 48（一致） | **0** |
| `_run.json.ok = false` | **5**（自述失败，其实可下单） | 3（一致） |

**危险方向是 0。** 也就是说在这份语料上，自述从来没有「瞒报通过」过 ——
它反而是**悲观**的：5 个目录自述失败，但产物其实是可下单的。

**但这不构成「以后也不会」的证据。** 这只是一次测量，而 `fabcheck` 的价值恰恰在于它是
**独立测量**而不是复述流水线的自评。所以规则不变：能不能下单，看 `fabcheck` 的退出码。

## 平台

**`pcb_build` 仅 Windows。** 它驱动 PowerShell 5.1/7 + 一个 Windows-only 的 EDA 服务端
（`lceda-pro.exe --owner`）。Linux/macOS 上插件能装载，`pcb_idea_to_design` / `pcb_fabcheck` /
`pcb_census` 可以用（要 Node ≥ 18.17；`pcb_census` 另需 Python 3），但 `pcb_build` 会退 **2**
（没能运行，不是「板子有问题」）。`pcb_verify` 要 PowerShell 7。

## 已知限制

- **没有一块板被真正制造过。** 全部结论都是「文件层面可打样」，不是「焊出来能用」。
- `pcb_build` 的自动布线在约 15% 的设计上会失败（DRC 剩余违规）。失败会重试三次，每次换更大的板框 ——
  实测**更大的板框经常更差**（某设计 SMD Pad↔Track 从 1 涨到 46）。
- `pcb_census` 的「在飞」判据依赖 `.pipeline.lock`。没有锁文件时，它只能退回「最近写入距今 < settle 秒」，
  而单次尝试可能长达 400 秒 —— 这个窗口不足以排除正在重构建的目录。
- 插件全部 5 个工具都是 `spawn` 子进程，**不会**在插件进程内做任何几何计算。这意味着插件很薄，
  也意味着它继承了流水线的全部缺陷。
- **插件不提供视频能力。** 出片（真实屏录 → 运镜 → 字幕配音 → 混音）是仓库里的
  `video/scripts/make-v11.ps1`，需要 Remotion + ffmpeg + 一次带窗口的录制，不在这 5 个工具里。
- **`files` 少一个被 import 的模块，插件在别人机器上就加载不起来**，而且本地永远复现不出来
  （本地是整个目录）。2026-11-27 真的踩过：`index.js` import `./locate-root.mjs`，
  而 `files` 里没有它。现在 `test/plugin-harness.mjs` 有一条专门的**打包完整性**断言，
  逐个把相对 import 对回 `files`；去掉那个文件就会红（已双向验证）。
