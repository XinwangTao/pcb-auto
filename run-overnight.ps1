# 长期无人值守守护：持续跑设计 → 独立校验 → 记录 → 失败自愈重试
#
# 用途：用户要求"任务持续到明天早上 10 点，一直做一直迭代优化"，
# 需要一个不会因单次失败而停摆的外层循环。
#
# 用法：
#   pwsh -NoProfile -File .\run-overnight.ps1
#   pwsh -NoProfile -File .\run-overnight.ps1 -Until "2026-11-26 10:00"
#   pwsh -NoProfile -File .\run-overnight.ps1 -Rounds 5      # 只跑 5 轮
#
# 行为：
#   - 每轮遍历 designs\d*.json（含 AI 生成的 gen-*.json）
#   - 每个设计走 run-all.ps1（内含自愈 + 独立校验 + 全局锁）
#   - 结果追加到 logs\overnight-<stamp>.log 与 logs\overnight-summary.json
#   - 单次失败不中断；连续 3 轮全盘失败才停下并报告（避免空转烧资源）
#   - 到达 -Until 时间自动收尾

param(
  [string]$Until = '',
  [int]$Rounds = 0,
  [string]$Pattern = '*.json',
  [int]$MaxConsecutiveAllFail = 3
)

$Root = $PSScriptRoot
$LockFile = Join-Path $Root '.pipeline.lock'
. (Join-Path $PSScriptRoot 'scripts\tool-paths.ps1')
$node = Resolve-Node

function Log2($msg, $color = 'Cyan') {
  $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
  Write-Host $line -ForegroundColor $color
  if ($script:logFile) { Add-Content -Path $script:logFile -Value $line -Encoding UTF8 }
}

function Get-LcedaMain {
  @(Get-CimInstance Win32_Process -Filter "Name='lceda-pro.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -notmatch '--type=' })
}

# 每个设计开跑前/跑完后都把 lceda 进程清空，建立不变式「一个设计 = 一组干净进程」。
#
# 为什么必须放在**设计之间**，而不是只放在 run-all 的 Ensure-Session 里：
# session close --destroy 只标记会话，不杀 OS 进程；Ensure-Session 又只在
# 「没有可复用会话」时才走到清理分支 —— 一旦复用现成会话，僵尸就一直留着。
# 实测代价（2026-11-25，同一设计同一代码）：干净环境 151s / DRC 0 违规；
# 进程攒到 6 个后 742s / 52 违规。攒到 10 个进程时 d11 一次就用了 437s。
#
# 另一个实测事实：**无法只杀一个**。lceda-pro 是单实例语义，杀掉任意一个主进程
# 会让全部 lceda-pro 一起退出（曾试图只清僵尸、保留在跑的那个，结果 10 个全灭，
# 连带打断了在飞的补线尝试）。所以这里不做"判活后精准清理"，直接清空。
# 另一个流水线实例持锁时，**绝不能**清进程：lceda-pro 是单实例语义，杀掉任意一个
# 主进程会让全部一起退出（见下），等于把别人在飞的设计打断。
#
# 实测事故（2026-11-26 00:48:29）：循环跑完 d7 后执行 'after' 清空，同时另一个
# 取片运行正持锁跑 gen-rp2040；清空把它唯一的 --owner 一起杀了，那次的日志出现
#   「.session 里的会话 … 已失效 → 启动新 headless session（第 1 次）」
# 后重新开会话才跑完。对普通运行只是变慢，对**录制的运行**是致命的：
# 帧会横跨两次会话，画面与叙事就不再是"同一次真实操作"。
#
# 所以先判锁：持锁者进程还活着就跳过清空。判活口径与 run-all.ps1 的
# Acquire-Lock 完全一致（读第一行 pid=，看进程在不在），避免两处各有一套定义。
function Get-ForeignLockHolder {
  if (-not (Test-Path $LockFile)) { return $null }
  $holderPid = $null
  try {
    $holderPid = [int]((Get-Content $LockFile -TotalCount 1 -ErrorAction Stop) -replace 'pid=', '')
  } catch { return $null }   # 读不动/读不成 = 视为没有有效持有者
  if (-not $holderPid) { return $null }
  if (Get-Process -Id $holderPid -ErrorAction SilentlyContinue) { return $holderPid }
  return $null               # 持有者已死 = 陈旧锁，可以清进程
}

# 修法：清理前**自己先把锁抢到手**，抢到才清。
#
# 「先判有没有人持锁、再清」还不够 —— 判与清之间是开着的窗口。实测 2026-11-26
# 01:20:05 就是这个窗口：循环判锁时无锁，取片在同一瞬间拿到锁，循环的 'after'
# 随即把取片刚起的 6 个进程杀掉（日志 `6 -> 1`）。判活是"读"，清进程是"做"，
# 两者之间必须有一个独占期，否则永远修不完。
#
# 所以改成「抢锁 → 清理 → 放锁」：抢锁用 CreateNew（原子，与 run-all.ps1 的
# Acquire-Lock 同一手法），抢不到就说明别人正在跑，直接跳过。
# 注意本函数**绝不排队**：它只是顺手做卫生，等锁会把整晚的循环拖死。
# 陈锁（持有者已死）就地清掉再抢一次。
function Try-Acquire-LockQuiet {
  for ($i = 0; $i -lt 3; $i++) {
    try {
      $fs = [IO.File]::Open($LockFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      $w = New-Object IO.StreamWriter($fs)
      $w.WriteLine("pid=$PID")
      $w.WriteLine("start=$(Get-Date -Format o)")
      $w.WriteLine("design=overnight-cleanup")
      $w.Flush(); $w.Close(); $fs.Close()
      return $true
    } catch {
      # 抢不到：要么别人活着在跑（跳过），要么是死人的陈锁（清掉重试）
      $holder = Get-ForeignLockHolder
      if ($holder) { return $false }
      Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
    }
  }
  return $false
}

function Reset-LcedaProcesses($when) {
  if (-not (Try-Acquire-LockQuiet)) {
    $holder = Get-ForeignLockHolder
    Log2 "  [$when] 跳过清空 lceda：流水线锁被 pid=$holder 持有（别的运行在跑，清进程会把它打断）" 'Yellow'
    return
  }
  try {
    Reset-LcedaProcessesLocked $when
  } finally {
    # 只放自己刚拿的那把锁（Try-Acquire-LockQuiet 成功后即为本人）
    if (Test-Path $LockFile) { Remove-Item $LockFile -Force -ErrorAction SilentlyContinue }
  }
}

function Reset-LcedaProcessesLocked($when) {
  # 以进程表为准（它就是最后用来校验"是否为 0"的那个口径）。
  # 主进程列表只用于报告——曾经用主进程判"有没有东西可清"，结果两个探测
  # 短暂不一致时会打出"清空 0 个（主进程 1 个）"这种自相矛盾的日志。
  $procs = @(Get-Process lceda-pro -ErrorAction SilentlyContinue)
  if (-not $procs.Count) { return }
  $mains = Get-LcedaMain
  $mb = 0
  foreach ($m in $mains) { $mb += [int]($m.WorkingSetSize / 1MB) }
  $n0 = $procs.Count
  foreach ($p in $procs) {
    try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { }
  }
  Start-Sleep -Seconds 2
  $n1 = @(Get-Process lceda-pro -ErrorAction SilentlyContinue).Count
  if ($n1 -eq 0) {
    Log2 "  [$when] 清空 lceda 进程 $n0 个（主进程 $($mains.Count) 个 / $mb MB）" 'DarkGray'
  } else {
    Log2 "  [$when] lceda 进程清理不干净：$n0 -> $n1（下一个设计可能被拖慢）" 'Red'
  }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$script:logFile = Join-Path $Root "logs\overnight-$stamp.log"
$summaryFile = Join-Path $Root "logs\overnight-summary.json"
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'logs') | Out-Null

$deadline = $null
if ($Until) {
  try { $deadline = [DateTime]::Parse($Until) }
  catch { throw "无法解析 -Until: $Until" }
}

Log2 "无人值守启动  deadline=$(if($deadline){$deadline}else{'不限'})  rounds=$(if($Rounds -gt 0){$Rounds}else{'不限'})" 'Green'

$round = 0
$allRuns = @()
$consecutiveAllFail = 0

while ($true) {
  if ($deadline -and (Get-Date) -ge $deadline) { Log2 "到达截止时间，收尾" 'Green'; break }
  if ($Rounds -gt 0 -and $round -ge $Rounds) { Log2 "完成 $Rounds 轮，收尾" 'Green'; break }
  $round++

  # 坑：原来默认 -Pattern 'd*.json' 只跑 13 个回归用例，
  # 而 designs\ 下真正的「从一句中文想法生成」产物是 gen-做一个-*.json（9 个），
  # 它们**从来没被无人值守循环跑过** —— 用户要的"想法→PCB"主路径反而没在回归里。
  # 改成 *.json 排除 _catalog 之类的下划线文件；按名字排序 d* 在 gen-* 之前，
  # 天然先跑回归、再跑想法生成。
  $designDir = Join-Path $Root 'designs'
  if (-not (Test-Path $designDir)) { throw "designs 目录不存在：$designDir" }
  $files = @(Get-ChildItem $designDir -Filter $Pattern -ErrorAction SilentlyContinue |
             Where-Object { $_.Name -notlike '_*' } | Sort-Object Name)
  if (-not $files) { Log2 "没有匹配 $Pattern 的设计文件，等待 60s" 'Yellow'; Start-Sleep 60; continue }

  Log2 "===== 第 $round 轮（$($files.Count) 个设计）=====" 'Cyan'
  $roundPass = 0
  $roundFail = 0

  foreach ($f in $files) {
    if ($deadline -and (Get-Date) -ge $deadline) { break }
    # 截止时间要预判：单设计最坏可达 ~40min（2 策略 × 590s + 紧凑 + 重烧）。
    # 原实现只在设计**之间**查 deadline，最后一个设计能越过 -Until 数小时。
    if ($deadline -and (Get-Date).AddMinutes(45) -ge $deadline) {
      Log2 "距截止不足 45min，不再起新设计" 'Yellow'; break
    }

    $sw = [Diagnostics.Stopwatch]::StartNew()
    # 起跑前先清一次：保证这个设计从干净环境开始。
    Reset-LcedaProcesses 'before'
    # 子进程必须带硬超时。原实现直接 `& pwsh ... | Out-String`，没有任何上限：
    # 一旦 run-all 里的 python/CLI 卡住，onight 循环永远不返回，
    # 整夜"看着在跑"却零进展且无告警。这是最贵的失败方式。
    $tmpOut = Join-Path $Root "logs\_ov-$($f.BaseName).out"
    $tmpErr = "$tmpOut.err"
    $hardCapMs = 45 * 60 * 1000
    $out = ''
    $code = 1
    try {
      $p = Start-Process -FilePath 'pwsh' `
        # -Record：把真实画布帧抓下来给视频用。**此前这里没传** —— run-all.ps1 有了
        # -Record 开关（L17），但通宵循环从没传过，于是整夜 0 张新帧（实测：
        # out\frames\ 14 个目录全是 01:48 之前的，其中 13 个还是空目录）。
        # 这是"能力已有、调用方不用"的典型：补丁落在 run-all 上，入口却还在老写法。
        # 代价约每块板 +10s / +1.6MB，可接受。
        -ArgumentList '-NoProfile', '-File', (Join-Path $Root 'run-all.ps1'), '-Design', "designs\$($f.Name)", '-Record' `
        -NoNewWindow -PassThru -RedirectStandardOutput $tmpOut -RedirectStandardError $tmpErr
      if (-not $p.WaitForExit($hardCapMs)) {
        Log2 "  $($f.Name) 超过 45min 硬上限，强制终止（防止整夜停摆）" 'Red'
        try { $p.Kill($true) } catch { }
        Start-Sleep -Seconds 3
        $code = 124
      } else {
        $code = $p.ExitCode
      }
      $out = (Get-Content $tmpOut -Raw -ErrorAction SilentlyContinue) + "`n" +
             (Get-Content $tmpErr -Raw -ErrorAction SilentlyContinue)
    } catch {
      Log2 "  启动 run-all 失败：$($_.Exception.Message)" 'Red'
    } finally {
      Remove-Item $tmpOut, $tmpErr -Force -ErrorAction SilentlyContinue
    }
    # 跑完立即清空：保证跑得越久环境越干净，而不是越跑越脏。
    Reset-LcedaProcesses 'after'
    $sw.Stop()
    $ok = ($code -eq 0)

    $heal = if ($out -match '自愈策略：([\w.-]+)') { $Matches[1] } else { $null }
    $nPass = ([regex]::Matches($out, '\[PASS\]')).Count
    $nFail = ([regex]::Matches($out, '\[FAIL\]')).Count
    # `$heal` 为空和 `$nFail` 为 0 都不是"没有"——是**没走到**。
    # 独立校验器只在流水线自述通过后才跑（run-all.ps1 L~711），
    # 自述失败的设计 `$nFail` 恒为 0，于是汇总行印出 `校验FAIL=0`，
    # 读起来像"0 个校验失败"（实测 2026-11-26 d13：`FAIL 572.8s 策略=? 校验FAIL=0`，
    # 而它其实是 3 轮 DRC 全败、根本没跑独立校验）。
    # 同理 `策略=?` 是"没走到终判"，不是某个叫 ? 的策略。
    # 统一改成显式文字，并保留原始计数便于脚本解析。
    $healTxt = if ($heal) { $heal } else { '未判定' }
    $checkTxt = if ($nPass + $nFail -eq 0) { '未执行（流水线自述已失败）' } else { "FAIL=$nFail / PASS=$nPass" }

    $rec = [pscustomobject]@{
      round = $round; design = $f.BaseName; ok = $ok; exit = $code
      sec = [Math]::Round($sw.Elapsed.TotalSeconds, 1); heal = $heal
      checkPass = $nPass; checkFail = $nFail; at = (Get-Date -Format o)
    }
    $allRuns += $rec

    if ($ok) { $roundPass++; Log2 ("  PASS  {0,-22} {1,6:N1}s  策略={2,-16} 独立校验 PASS={3}" -f $f.BaseName, $sw.Elapsed.TotalSeconds, $healTxt, $nPass) 'Green' }
    else {
      $roundFail++
      Log2 ("  FAIL  {0,-22} {1,6:N1}s  策略={2,-16} 独立校验 {3}" -f $f.BaseName, $sw.Elapsed.TotalSeconds, $healTxt, $checkTxt) 'Red'
      # 把失败详情落盘，便于事后定位
      $detail = Join-Path $Root "logs\fail-$($f.BaseName)-$stamp-r$round.txt"
      Set-Content -Path $detail -Value $out -Encoding UTF8
      Log2 "        详情 -> $detail" 'DarkYellow'
    }
  }

  Log2 "第 $round 轮结果: $roundPass 通过 / $roundFail 失败"
  if ($roundFail -gt 0 -and $roundPass -eq 0) {
    $consecutiveAllFail++
    Log2 "全盘失败计数 $consecutiveAllFail / $MaxConsecutiveAllFail" 'Yellow'
    if ($consecutiveAllFail -ge $MaxConsecutiveAllFail) {
      Log2 "连续 $MaxConsecutiveAllFail 轮全盘失败，停止（请检查 EDA 进程/session）" 'Red'
      break
    }
  } else {
    $consecutiveAllFail = 0
  }

  # 每轮结束写汇总
  try {
    $allRuns | ConvertTo-Json -Depth 4 | Set-Content -Path $summaryFile -Encoding UTF8
  } catch { }

  # 每 3 轮自动清理，防止 20 小时运行把磁盘/进程撑爆
  # （实测 3 小时就积累 143 个 out 目录 + 191 个 EDA 工程、136MB）
  if ($round % 3 -eq 0) {
    Log2 '自动清理旧产物与 EDA 工程…' 'DarkGray'
    try {
      $cl = (& pwsh -NoProfile -File (Join-Path $Root 'scripts\cleanup.ps1') -Apply 2>&1 | Out-String)
      $cl -split "`n" | Where-Object { $_ -match '已删除' } | ForEach-Object { Log2 "  $($_.Trim())" 'DarkGray' }
    } catch { Log2 "  清理失败（不影响继续）: $($_.Exception.Message)" 'Yellow' }
  }

  Start-Sleep -Seconds 5
}

Write-Host ''
Log2 '================ 无人值守汇总 ================' 'Green'
if ($allRuns.Count) {
  $tot = $allRuns.Count
  $okN = @($allRuns | Where-Object ok).Count
  Write-Host ("总运行次数     : {0}" -f $tot)
  Write-Host ("通过           : {0}  ({1:P1})" -f $okN, ($okN / $tot))
  Write-Host ("平均耗时       : {0:N1}s" -f (($allRuns | Measure-Object sec -Average).Average))
  Write-Host ("涉及设计       : {0}" -f (($allRuns | Select-Object -ExpandProperty design -Unique) -join ', '))
  $byDesign = $allRuns | Group-Object design | ForEach-Object {
    $o = @($_.Group | Where-Object ok).Count
    "  {0,-24} {1}/{2}" -f $_.Name, $o, $_.Count
  }
  Write-Host '按设计:'
  $byDesign | ForEach-Object { Write-Host $_ }
}
Write-Host '==============================================' -ForegroundColor Green
exit $(if (@($allRuns | Where-Object ok).Count -gt 0) { 0 } else { 1 })
