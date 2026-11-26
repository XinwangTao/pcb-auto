# safe-edit.ps1 —— 对 pipeline3.js 这类"正在被夜间循环反复读取"的文件做原子替换
#
# 为什么必须有这个脚本：
#   2026-11-25 23:55 我用连续多次 in-place edit 改 pipeline3.js，而夜间循环是**每个设计
#   重新读一次**这个文件。结果一次真实运行（gen-led）读到了中间的半成品状态
#   （173,060 B / sha 8d96f7eccebe，不是最终的 173,932 B / 4e391fbbe1bd）——
#   那次侥幸语法合法且通过了 18 项校验，但这是运气，不是流程。
#   正确做法：改动一律先写到 <target>.next，在**候选文件上**跑完全部闸门，再一次性 Move
#   到正式路径。Move 是原子替换，读的一方要么看到旧文件、要么看到新文件，不会看到中间态。
#
# 用法：
#   pwsh -NoProfile -File scripts\safe-edit.ps1 -Candidate scripts\pipeline3.js.next -Target scripts\pipeline3.js
#   可选 -AlsoRun 'scripts\_test-lshape.js' 追加一个 node 测试脚本（会拿候选文件路径当 argv[2]）
param(
  [Parameter(Mandatory = $true)][string]$Candidate,
  [Parameter(Mandatory = $true)][string]$Target,
  [string]$AlsoRun = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'tool-paths.ps1')
$Node = Resolve-Node
$Root = Split-Path -Parent $PSScriptRoot
# 路径归一化必须用 [IO.Path]::IsPathRooted，不能写 StartsWith('\\')：
# 后者只认 UNC（\\server\share），把 F:\cache\x.js 这种盘符绝对路径当成相对路径，
# 于是拼成 <cwd>\F:\cache\x.js 然后报"候选文件不存在"——错在判定，不在文件。
if (-not [IO.Path]::IsPathRooted($Candidate)) { $Candidate = Join-Path (Get-Location).Path $Candidate }
if (-not [IO.Path]::IsPathRooted($Target)) { $Target = Join-Path (Get-Location).Path $Target }
if (-not (Test-Path $Candidate)) { Write-Host "  候选文件不存在：$Candidate" -ForegroundColor Red; exit 2 }
if (-not (Test-Path $Target)) { Write-Host "  目标文件不存在：$Target" -ForegroundColor Red; exit 2 }
if (-not (Test-Path $Node)) { Write-Host "  node 不存在：$Node" -ForegroundColor Red; exit 2 }

function Fail($why) {
  Write-Host "  ✗ $why —— 候选被丢弃，正式文件未改动" -ForegroundColor Red
  Remove-Item $Candidate -Force -ErrorAction SilentlyContinue
  exit 1
}

# 1) 扩展函数体语法闸门。pipeline3.js 是**扩展 async 函数体**，不是模块：
#    node --check 对它无效（Illegal return statement），必须包一层再编译。
$gateJs = Join-Path $env:TEMP 'safe-edit-fbody.js'
@'
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
try {
  new Function('eda', 'log', 'sleep', 'left', 'phase',
    "'use strict';\nreturn (async () => {\n" + src + "\n})();");
  console.log('FUNC_BODY_OK');
} catch (e) { console.log('FUNC_BODY_FAIL: ' + e.message); process.exit(1); }
'@ | Set-Content $gateJs -Encoding UTF8
$o = (& $Node $gateJs $Candidate 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { Fail "语法闸门未过：$o" }
Write-Host "  ✓ $o"

# 2) 丢弃 delete/modify 返回值（本仓库失败是返回值不是异常，静态拦）
$lint = Join-Path $Root 'scripts\lint-retval.js'
if (Test-Path $lint) {
  $o = (& $Node $lint $Candidate 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { Fail "lint-retval 未过：$o" }
  Write-Host '  ✓ lint-retval'
} else { Fail "缺少 lint-retval.js（缺失不能当通过）" }

# 3) 契约检查
$sc = Join-Path $Root 'scripts\staticcheck.js'
if (Test-Path $sc) {
  $o = (& $Node $sc $Candidate 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { Fail "staticcheck 未过：$o" }
  Write-Host '  ✓ staticcheck'
} else { Fail "缺少 staticcheck.js（缺失不能当通过）" }

# 4) 可选追加测试（拿候选路径当参数，保证测的是候选而不是正式文件）
if ($AlsoRun) {
  $ex = Join-Path $Root $AlsoRun
  if (-not (Test-Path $ex)) { Fail "追加测试不存在：$ex" }
  $o = (& $Node $ex $Candidate 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { Fail "追加测试未过：$o" }
  Write-Host "  ✓ $AlsoRun"
}

# 5) 原子替换。必须用 Move(, $true)：[IO.File]::Replace 在拿 $null 当 backup 时会抛
#    「The path is empty」，而 Move 覆盖是原子的。
$len = (Get-Item $Candidate).Length
[IO.File]::Move($Candidate, $Target, $true)
$sha = (Get-FileHash $Target -Algorithm SHA256).Hash.Substring(0, 12).ToLower()
Write-Host "  ✓ 已原子替换：$len 字节 / sha=$sha" -ForegroundColor Green
exit 0
