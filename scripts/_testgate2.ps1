# 证明 Test-PipelineSyntax 现在能区分「语法不通」和「契约不通」。
# 以前两者都 return $false，调用方无法分流 -> 契约缺陷被报成语法错误并触发静默回退。
# 这个测试的价值全在于**它必须能测出区分能力**：如果两个坏样本都报同一个 GateFailed，
# 测试就失败。只断言"函数返回 false"是不够的 —— 那在改之前也能通过。
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
. (Join-Path $Root 'scripts\tool-paths.ps1')
$NodeExe = Resolve-Node
$ScriptFile = Join-Path $Root 'scripts\pipeline3.js'
function Log([string]$m, [string]$c = 'Gray') { Write-Host ('    ' + $m) }
Log '  依赖已解析' 'DarkGray'

# 从 run-all.ps1 里抽出要测的两个函数（不重抄，避免测的和跑的不是同一份代码）
$runAll = Get-Content (Join-Path $Root 'run-all.ps1') -Raw
function Get-FnText([string]$name) {
  $m = [regex]::Match($runAll, "(?ms)^function\s+$name\b.*?(?=^function\s|\z)")
  if (-not $m.Success) { throw "在 run-all.ps1 里找不到函数 $name" }
  return $m.Value
}
$tmpMod = Join-Path $env:TEMP ('gate-' + [guid]::NewGuid().ToString('N') + '.ps1')
try {
  $body = "`$ErrorActionPreference='Stop'`n" +
          "function Log([string]`$m,[string]`$c='Gray'){ Write-Host ('    ' + `$m) }`n" +
          "`$NodeExe = '$NodeExe'`n" +
          "`$Root = '$Root'`n" +
          (Get-FnText 'Test-PipelineSyntax')
  Set-Content -Path $tmpMod -Value $body -Encoding UTF8
  . $tmpMod

  $pass = 0; $fail = 0
  function Check([string]$label, [bool]$cond, [string]$detail) {
    if ($cond) { $script:pass++; Log ("  PASS  " + $label) }
    else { $script:fail++; Log ("  FAIL  " + $label + "  " + $detail) 'Red' }
  }

  # ① 好文件：两关都过
  $ok = Test-PipelineSyntax $ScriptFile
  Check '好文件通过' ($ok -eq $true) ("实际 " + $ok)

  # ② 语法坏文件：必须记为 'syntax'
  $badSyntax = Join-Path $env:TEMP ('bs-' + [guid]::NewGuid().ToString('N') + '.js')
  Set-Content -Path $badSyntax -Value "let a = ;`nreturn 1;" -Encoding UTF8
  $r2 = Test-PipelineSyntax $badSyntax
  Check '语法坏 -> false' ($r2 -eq $false) ("实际 " + $r2)
  Check '语法坏 -> GateFailed=syntax' ($script:GateFailed -eq 'syntax') ("实际 '" + $script:GateFailed + "'")

  # ③ 契约坏文件：语法合法、但引用了不存在的变量。
  #    形状照抄那个真实事故（d8-led-8ch：返回对象引用 drcLeafCount，let 声明还没写进去）。
  $badContract = Join-Path $env:TEMP ('bc-' + [guid]::NewGuid().ToString('N') + '.js')
  Set-Content -Path $badContract -Value @'
async function main() {
  const x = 1;
  return { ok: true, drcLeafCount };
}
return await main();
'@ -Encoding UTF8
  $r3 = Test-PipelineSyntax $badContract
  Check '契约坏 -> false' ($r3 -eq $false) ("实际 " + $r3)
  # 这一条是本测试的全部意义：改之前这里会是 'syntax'（因为函数直接 return $false 前没标记）。
  Check '契约坏 -> GateFailed=contract（不再是 syntax）' ($script:GateFailed -eq 'contract') ("实际 '" + $script:GateFailed + "'")

  # ④ 反向确认：两个坏样本报告的类别**不相同**。若相同，分化就白做了。
  Test-PipelineSyntax $badSyntax | Out-Null; $g1 = $script:GateFailed
  Test-PipelineSyntax $badContract | Out-Null; $g2 = $script:GateFailed
  Check '两类失败可被区分' ($g1 -ne $g2) ("两个都报 '" + $g1 + "'")

  Log ''
  Log ("  合计 PASS=$pass FAIL=$fail")
  if ($fail -gt 0) { exit 1 }
  exit 0
}
finally {
  Remove-Item $tmpMod, $badSyntax, $badContract -Force -ErrorAction SilentlyContinue
}
