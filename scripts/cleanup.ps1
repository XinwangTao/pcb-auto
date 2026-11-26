# 自动清理：长期无人值守必然积累大量产物目录与 EDA 工程
#
# 实测：跑 ~3 小时积累 143 个 out 目录(52MB) + 191 个工程(112MB)。
# 20 小时不清理会到 GB 级并拖慢 EDA。此脚本按"保留最近 N 个 + 最新一次每设计"策略清理。
#
# 用法：
#   pwsh -NoProfile -File .\scripts\cleanup.ps1              # 预演，只报告
#   pwsh -NoProfile -File .\scripts\cleanup.ps1 -Apply       # 真删
#   pwsh -NoProfile -File .\scripts\cleanup.ps1 -Apply -KeepOut 30
#
# 安全原则：
#   - 默认只预演（dry run），必须显式 -Apply
#   - 每个设计名至少保留最新 1 份产物，便于随时复查
#   - 不动 video/、designs/、scripts/、api/
#   - 删工程前确认目录名含 AI_ 前缀（只清理本流水线建的）

param(
  [switch]$Apply,
  [int]$KeepOut = 40,
  [int]$KeepLogs = 60,
  [switch]$SkipProjects
)

$Root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $Root 'run-all.ps1'))) { $Root = $PSScriptRoot }

function Say($m, $c = 'Cyan') { Write-Host "[cleanup] $m" -ForegroundColor $c }

$mode = if ($Apply) { '执行' } else { '预演（加 -Apply 才真删）' }
Say "模式: $mode"

# ---------- 1. out 目录 ----------
$outRoot = Join-Path $Root 'out'
if (Test-Path $outRoot) {
  $dirs = Get-ChildItem $outRoot -Directory | Sort-Object LastWriteTime -Descending
  Say ("out 目录 {0} 个，保留最近 {1} 个 + 每个设计最新 1 份" -f $dirs.Count, $KeepOut)

  # 每个设计名的最新一份必须留（名字形如 <Design>-<stamp>）
  $latestByDesign = @{}
  foreach ($d in $dirs) {
    $base = ($d.Name -replace '-\d{8}-\d{6}$', '')
    if (-not $latestByDesign.ContainsKey($base)) { $latestByDesign[$base] = $d.FullName }
  }
  $mustKeep = @($latestByDesign.Values)
  $recent = @($dirs | Select-Object -First $KeepOut | ForEach-Object { $_.FullName })

  $toDelete = @()
  foreach ($d in $dirs) {
    if ($mustKeep -contains $d.FullName) { continue }
    if ($recent -contains $d.FullName) { continue }
    $toDelete += $d
  }
  $sz = if ($toDelete.Count) { ($toDelete | ForEach-Object { (Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum } | Measure-Object -Sum).Sum/1MB } else { 0 }
  Say ("  将删除 {0} 个目录，释放 {1:N1} MB" -f $toDelete.Count, $sz) 'Yellow'
  if ($Apply) {
    $n = 0
    foreach ($d in $toDelete) {
      try { Remove-Item $d.FullName -Recurse -Force -ErrorAction Stop; $n++ } catch { }
    }
    Say ("  已删除 $n 个") 'Green'
  }
}

# ---------- 2. logs ----------
$logRoot = Join-Path $Root 'logs'
if (Test-Path $logRoot) {
  $logs = Get-ChildItem $logRoot -File | Sort-Object LastWriteTime -Descending
  $del = @($logs | Select-Object -Skip $KeepLogs)
  $sz = if ($del.Count) { ($del | Measure-Object Length -Sum).Sum/1MB } else { 0 }
  Say ("logs 保留最近 {0} 个，将删除 {1} 个（{2:N1} MB）" -f $KeepLogs, $del.Count, $sz) 'Yellow'
  if ($Apply -and $del.Count) {
    $del | Remove-Item -Force -ErrorAction SilentlyContinue
    Say '  logs 已清理' 'Green'
  }
}

# ---------- 3. EDA 工程目录 ----------
# 只清理本流水线创建的（名字含 AI_），且保留最近 10 个，避免误删用户自己的工程
if (-not $SkipProjects) {
  $pd = 'D:\Users\陶鑫旺\Documents\LCEDA-Pro\projects'
  if (Test-Path $pd) {
    $projs = Get-ChildItem $pd -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
    $mine = @($projs | Where-Object { $_.Name -like 'AI_*' })
    $del = @($mine | Select-Object -Skip 10)
    $sz = if ($del.Count) { ($del | ForEach-Object { (Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum } | Measure-Object -Sum).Sum/1MB } else { 0 }
    Say ("EDA 工程共 {0}（其中 AI_ 建的 {1}），保留最近 10 个 AI 工程，将删除 {2} 个（{3:N1} MB）" -f $projs.Count, $mine.Count, $del.Count, $sz) 'Yellow'
    if ($Apply -and $del.Count) {
      $n = 0
      foreach ($p in $del) {
        try { Remove-Item $p.FullName -Recurse -Force -ErrorAction Stop; $n++ } catch { }
      }
      Say ("  已删除 $n 个 AI 工程（用户自建工程未触碰）") 'Green'
    }
  } else {
    Say "工程目录不存在，跳过: $pd" 'DarkGray'
  }
}

Say '完成'
