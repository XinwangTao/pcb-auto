$Root = Split-Path -Parent $PSScriptRoot
function Log($m, $c = 'Cyan') { Write-Host "    [log] $m" }

# 从 run-all.ps1 逐字提取闸门代码，确保测的是真代码而不是副本
$all = Get-Content (Join-Path $Root 'run-all.ps1') -Raw
$s = $all.IndexOf('# ---------- 代码完整性闸门 ----------')
$e0 = $all.IndexOf("throw 'pipeline3.js 与备份都无法通过语法检查")
$e = $all.IndexOf("`n}", $e0) + 2      # 连函数自身的收尾右括号一起取
$block = $all.Substring($s, $e - $s)
Write-Host "  已提取闸门代码 $($block.Length) 字符"
Invoke-Expression $block

Write-Host '--- 用例1：好文件 -> 应返回正式文件 ---'
$ScriptFile = Join-Path $Root 'scripts\pipeline3.js'
$ScriptBackup = Join-Path $Root 'scripts\_gate-test-lastgood.js'
Remove-Item $ScriptBackup -Force -ErrorAction SilentlyContinue
$r = Get-PipelineScript
Write-Host "    returned: $(Split-Path $r -Leaf)   备份已建立: $(Test-Path $ScriptBackup)"

Write-Host '--- 用例2：坏文件 + 有备份 -> 应退回备份 ---'
$broken = Join-Path $Root 'scripts\_gate-test-broken.js'
$good = Get-Content (Join-Path $Root 'scripts\_gate-test-lastgood.js') -Raw
Set-Content $broken ($good -replace '(?m)^\}', '') -Encoding UTF8
$ScriptFile = $broken
$r = Get-PipelineScript
Write-Host "    returned: $(Split-Path $r -Leaf)   (期望 _gate-test-lastgood.js)"

Write-Host '--- 用例3：坏文件 + 无备份 -> 应抛错 ---'
$ScriptBackup = Join-Path $Root 'scripts\_gate-test-nonexistent.js'
try {
  $r = Get-PipelineScript
  Write-Host '    !! 没抛错，闸门失效'
} catch {
  Write-Host "    正确抛错: $($_.Exception.Message.Substring(0, [Math]::Min(30, $_.Exception.Message.Length)))..."
}

Remove-Item $broken -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $Root 'scripts\_gate-test-lastgood.js') -Force -ErrorAction SilentlyContinue
Write-Host '  清理完成'
