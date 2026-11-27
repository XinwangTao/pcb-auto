# `run-all.ps1` 会死在开 session 这一步：本机没有 WMIC，而它每次都先把服务端清到 0

> 记录时间：2026-11-26 22:5x（Asia/Shanghai）
> 触发：连续三次 `taskkill /F /IM lceda-pro.exe /T` 之后，构建再也起不来。
> 症状：`REQUEST_TIMEOUT` → `SPAWN_OWNER_FAILED: spawn C:\WINDOWS\System32\wbem\WMIC.exe ENOENT` → `ENDPOINT_UNAVAILABLE`
> → `无法获得可用 EDA session（已重试 3 次）`，`run-all` exit 1。

## 一、死锁链条（三处都读过源码/实测过）

`run-all.ps1` 的 `Ensure-Session` 分三步：

1. **读 `.session` 文件**里的会话 id，探活；活着就直接用。
2. **复用 `session list` 里现成的 `headless` + `origin=cli` 会话**。
3. 都不行才开新的，而这一步的**第一件事**是 `Remove-AllLceda`：

```
# 开新会话前把服务端清到 **0 个**，这是唯一确定性判据。
# 注意：杀掉服务端会让全部 lceda-pro 一起退出（客户端与子进程都挂在它下面）
```

清完之后 `& $CLI open --headless true`。而 `open` 要重新拉起一个服务端副本，
本机 `WMIC.exe` **不存在**（`Test-Path C:\WINDOWS\System32\wbem\WMIC.exe` → `False`），
于是 `SPAWN_OWNER_FAILED`，重试 3 次后 throw。

**第 2 步救不了**：手动起客户端得到的会话是 `headless:false, origin:user`，
不满足「`headless` 且 `origin=cli`」这个过滤条件。而第 1 步的 `.session`
里存着的是上一轮已被杀掉的 id。

所以：**在没有 WMIC 的机器上，一旦服务端被杀干净，`run-all.ps1` 就不可能自己恢复。**
这不是偶发抖动，是确定性的。

## 二、恢复办法（实测可用，22:58）

```powershell
$cli = 'E:\APP\lceda-pro\lceda-pro.exe'
# ① 手动起客户端 —— 报错信息自己就建议这么做（"start the client manually and retry"）
Start-Process -FilePath $cli -WorkingDirectory 'E:\APP\lceda-pro'
Start-Sleep -Seconds 20
# 实测：进程数 0 → 14（GUI 会拉一堆子进程），session list 出现 origin=user 的会话

# ② 在活着的服务端之上开一个 headless 会话（**不要**先杀进程）
$open = & $cli open --headless true | Out-String
$sid = ($open | ConvertFrom-Json).value.sessionId      # 实测 4de002b2-… / durationMs=779

# ③ 写进 .session，让 Ensure-Session 第 1 步直接命中（从而永不调用 Remove-AllLceda）
Set-Content -Path .session -Value $sid -NoNewline

# ④ 再跑 run-all
pwsh -NoProfile -ExecutionPolicy Bypass -File .\run-all.ps1 -Design designs\mic-esp32s3-v5.json -MaxAttempts 1
```

日志里应出现「流水线启动：…」而**不是**「启动新 headless session（第 N 次）」。
后者出现就说明又走到第 3 步了，会再次把服务端清掉。

## 三、以后别再踩

- **不要用 `taskkill /F /IM lceda-pro.exe /T` 收尾。** 它会连服务端一起杀掉，
  而服务端在这台机器上**不能自己重生**。要结束一次尝试，用 `lceda-pro.exe session close`/`session abort`。
- 判断是否「有人在跑」用 `.pipeline.lock` + 数带 `--owner` 的进程，不要靠杀进程解决冲突。
- 想根治：`Ensure-Session` 第 2 步的过滤条件应放宽到「任何 `status=alive` 的会话」，
  或者第 3 步不要无条件 `Remove-AllLceda`（先试 `open`，失败再清）。
  这是**代码改动**，需要它自己的红/绿证明，本轮未做。

## 四、顺带一个好消息：失败路径也会留下独立证据

这次 `run-all` 在第 435 行 throw，但 `finally` 仍然写出了
`out/ESP32S3_Wireless_Mic_V5-20261126-224537/_gates.independent.json` ——
那份文件由**复核者**写、不是生产者写，失败时最容易在 `$OutDir` 里留下一份旧的 `ok:true`，
所以它必须在 `finally` 里落盘。这条设计是对的，本轮实测到了。
