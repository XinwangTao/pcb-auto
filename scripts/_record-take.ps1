# _record-take.ps1 —— 取一条"真实且通过"的录制素材。
#
# 视频的硬要求（用户明确提过两次）：
#   · 必须是 AI **真实操作软件**的过程（一步步画图布线），不是示意图；
#   · 叙事只能描述这次录制**真的做了**的事。
# 所以不能拿"失败的运行"凑画面：一次失败的运行里，布线轮次、覆铜、DRC 清零
# 这些关键动作要么没发生、要么被打回，配音就会变成谎话。
#
# 本脚本反复跑 run-all.ps1 -Record，直到某一次：
#   1) _run.json        ok = true
#   2) gates            drcLeafCount = 0 且 drcPassed = true 且 routeState = completed
#   3) 帧目录里**故事节拍齐全**：pcb-layout / pcb-routed / pcb-drc 都在，
#      且至少有一张布线等待帧（route-t* / route2-t*）—— 那是"正在布线"的唯一证据，
#      只有终态截图的话视频就成了幻灯片；
#   4) **唯一画面数 >= -MinFrames**（按 SHA256 去重，不是 PNG 文件数）。
# 四条同时成立才停。任何一条不成立就再来一次。
#
# 【为什么不能用"PNG 数量 >= N"当判据】
# 第一版就是这么写的（MinFrames=16），结果把一条真实通过的运行判成失败：
# AI_RP2040_系统_15pqy38-20261126-004827 是 ok=true / drcLeaf=0 / 6件产物齐全的
# 干净通过，但只出了 11 张 PNG，于是被判失败、白跑一轮。
# 而且那 11 张里有重复：pcb-pour ≡ route2-t6s，clearance ≡ patched ≡ drc
# （DRC 已经零违规时，后三个阶段画布本来就不变）。**文件数不等于画面数。**
# 真正的要求是"讲故事需要的节拍在不在"，那是结构判据，不是计数判据。
#
# 为什么需要重试：run-all 自己带"自愈策略"（smart-fit → expand-1.25x），
# 但"两次尝试都通过"与"第一次就通过"是两件事；而帧目录是按尝试分的，
# 取最新尝试的帧才能保证画面与"通过"是同一次运行。
param(
  [string]$Design = 'designs\gen-rp2040.json',
  [int]$MaxTries = 4,
  # 最少**唯一**画面数。成片固定 8 段（tts_v7.py 硬编码 8 行），所以下限就是 8。
  [int]$MinFrames = 7
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
# 出片器（curate-v7.mjs）要用 node 跑，判据4 会调它。路径写死不如留一个明确失败。
$node = 'E:\APP\nodejs24\node.exe'
if (-not (Test-Path $node)) {
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c) { $node = $c.Source } else { throw "找不到 node（判据4 需要跑 curate-v7.mjs）：$node" }
}
if (-not (Test-Path (Join-Path $Root 'run-all.ps1'))) { throw "推不出 pcb-auto 根目录：$Root" }

function Say($m, $c = 'Cyan') { Write-Host "[take] $m" -ForegroundColor $c }

for ($i = 1; $i -le $MaxTries; $i++) {
  Say "===== 第 $i / $MaxTries 次取片：$Design =====" 'Magenta'
  $t0 = Get-Date

  # run-all.ps1 自己的锁是"排队等待"，所以这里不会和夜间循环抢崩；
  # 它等锁期间不建帧目录（帧目录在拿到锁之后才建），这是安全的。
  # 必须 try/catch：本脚本 $ErrorActionPreference='Stop'，被调用脚本里任何 throw
  # 都会把整个取片过程中断 —— 而"这次没通过"本来就是预期内的，不能因此放弃重试。
  $rc = $null
  try { & (Join-Path $Root 'run-all.ps1') -Design $Design -Record; $rc = $LASTEXITCODE }
  catch {
    Say ("第 $i 次：run-all 抛异常 —— " + $_.Exception.Message) 'Red'
    continue
  }

  # ---- 1) 找到这次产生的运行目录（按 _run.json 的修改时间，且晚于本次开始）----
  $runDir = $null; $run = $null
  $cands = Get-ChildItem (Join-Path $Root 'out') -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName '_run.json') } |
    Sort-Object LastWriteTime -Descending
  foreach ($c in $cands) {
    if ($c.LastWriteTime -gt $t0.AddSeconds(-5)) {
      try { $run = Get-Content (Join-Path $c.FullName '_run.json') -Raw | ConvertFrom-Json } catch { $run = $null }
      if ($run) { $runDir = $c; break }
    }
  }
  if (-not $runDir) { Say "第 $i 次：找不到本次的 _run.json（run-all exit=$rc），重试" 'Red'; continue }

  # ---- 2) 找这次产生的帧目录（最新，且晚于本次开始）----
  $framesRun = Get-ChildItem (Join-Path $Root 'out\frames') -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -gt $t0.AddSeconds(-5) } |
    Sort-Object Name -Descending | Select-Object -First 1
  $frameSub = $null
  if ($framesRun) {
    $frameSub = Get-ChildItem $framesRun.FullName -Directory -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending | Select-Object -First 1
  }
  $frameDir = if ($frameSub) { $frameSub.FullName } elseif ($framesRun) { $framesRun.FullName } else { $null }

  # ---- 3) 从文件名取出节拍标记，并按内容哈希去重 ----
  $png = 0; $uniq = 0; $tags = @()
  if ($frameDir) {
    $files = @(Get-ChildItem $frameDir -Filter '*.png' -File -ErrorAction SilentlyContinue)
    $png = $files.Count
    if ($png -gt 0) {
      $tags = @($files | ForEach-Object {
          ($_.BaseName -replace '^\d+-', '')   # 0006-pcb-routed -> pcb-routed
        })
      $uniq = @($files | ForEach-Object { (Get-FileHash $_.FullName -Algorithm SHA256).Hash } |
          Sort-Object -Unique).Count
    }
  }
  $hasLayout = ($tags -contains 'pcb-layout')
  $hasRouted = ($tags -contains 'pcb-routed')
  $hasDrc    = ($tags -contains 'pcb-drc')
  # "正在布线"的等待帧：route-t16s / route2-t6s
  $nRouteWait = @($tags | Where-Object { $_ -match '^route2?-t\d+s$' }).Count

  $g = $run.gates
  $okRun = ($run.ok -eq $true) -and ($g.drcLeafCount -eq 0) -and ($g.drcPassed -eq $true) -and
           ($g.routeState -eq 'completed')
  $okBeats = $hasLayout -and $hasRouted -and $hasDrc -and ($nRouteWait -ge 1)
  # 【判据4 与出片闸门必须是同一套判据】原先这里数"唯一画面数"，而 curate-v7.mjs
  # 数的是"能被叙事角色认领的独立画面数"——两个数不同：一张 sch-wired 能让唯一画面
  # +1，却不会成为任何角色（旧版没有原理图段），于是取片判"够了"、出片判"不够"，
  # 或者反过来。2026-11-26 012933 就是这样：唯一 6 < 8 被拒，可那次 ok=True、
  # DRC 0 违规、独立校验 18/18 —— 素材问题被记成设计失败。
  # 现在直接问出片器："这一场能剪出几段？"，以它的答案为准。
  $segCount = 0; $segRoles = @(); $curateMsg = ''
  if ($frameDir) {
    $curate = Join-Path $PSScriptRoot '..\video\out\_probe\curate-v7.mjs'
    if (Test-Path $curate) {
      $co = (& $node $curate --frames $frameDir --dry --json 2>&1 | Out-String)
      $curateMsg = $co.Trim()
      try {
        # --json 只吐一行 JSON，直接解析角色列表。
        # 不要从中文 label 里切词：'布线 · 起' 会被切成一个字，判断就失真了。
        $cj = ($co.Trim() -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1) | ConvertFrom-Json
        $segCount = [int]$cj.segments
        $segRoles = @($cj.roles)
      } catch {
        $segCount = 0; $segRoles = @()
      }
    }
  }
  # 7 段 ≈ 29.3s、8 段 ≈ 31.6s（段长公式见 video\src\PcbRealV7.jsx）。
  # 少于 7 段撑不起竖屏短片，也说明这一场没拍到过程；且"DRC 全绿"这个结论段
  # 必须真的存在——它是全片最强的一句，不能靠别的画面代答。
  $hasDrcSeg = ($segRoles -contains 'drc')
  $okFrames = ($segCount -ge $MinFrames) -and $hasDrcSeg
  $okAll = $okRun -and $okBeats -and $okFrames

  Say ("第 $i 次：ok={0} drcLeaf={1} route={2} PNG={3} 唯一={4} 可剪={5}段 drc段={6} 节拍[layout={7} routed={8} drc={9} 布线等待={10}]" -f `
      $run.ok, $g.drcLeafCount, $g.routeState, $png, $uniq, $segCount, $hasDrcSeg, $hasLayout, $hasRouted, $hasDrc, $nRouteWait) `
    $(if ($okAll) { 'Green' } else { 'Yellow' })

  if ($okAll) {
    Say "取片成功 —— 真实操作 + 本次通过" 'Green'
    Write-Host ("TAKE=PASS") -ForegroundColor Green
    Write-Host ("TAKE_RUN=" + $runDir.FullName)
    Write-Host ("TAKE_FRAMES=" + $frameDir)
    Write-Host ("TAKE_PNG=" + $png)
    Write-Host ("TAKE_UNIQ=" + $uniq)
    Write-Host ("TAKE_SEGS=" + $segCount)
    Write-Host ("TAKE_TRY=" + $i)
    exit 0
  }
  if (-not $okRun)   { Say ("  ✗ 判据1/2 未过：这次运行没真正通过（ok/drcLeaf/route 之一不满足）") 'DarkYellow' }
  if (-not $okBeats) { Say ("  ✗ 判据3 未过：缺故事节拍（layout={0} routed={1} drc={2} 布线等待={3}）" -f $hasLayout, $hasRouted, $hasDrc, $nRouteWait) 'DarkYellow' }
  if (-not $okFrames){
    Say ("  ✗ 判据4 未过：可剪 {0} 段（需 >= {1} 且必须含 DRC 段）、唯一画面 {2}" -f $segCount, $MinFrames, $uniq) 'DarkYellow'
    if ($curateMsg) { Say ("    curate 说：" + (($curateMsg -split "`n" | Where-Object { $_ -match '⚠|凑不出|不讲' }) -join ' / ')) 'DarkGray' }
  }
  Say "第 $i 次不满足上片条件，继续" 'DarkYellow'
}
Say "连续 $MaxTries 次都没拿到可用素材" 'Red'
Write-Host "TAKE=FAIL" -ForegroundColor Red
exit 3
