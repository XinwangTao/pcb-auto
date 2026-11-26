# 把 lceda-pro 的 eda API 全量 doc 抓成磁盘知识库
$ErrorActionPreference = 'Continue'
$cli = 'E:\APP\lceda-pro\lceda-pro.exe'
$root = 'D:\Users\陶鑫旺\Documents\deepseek-harness\default-workspace\pcb-auto\api'
New-Item -ItemType Directory -Force -Path $root | Out-Null

Write-Output '=== 1. fetch index ==='
$idxRaw = (& $cli doc api 2>&1 | Out-String)
$idxFile = Join-Path $root '_index.raw.json'
Set-Content -Path $idxFile -Value $idxRaw -Encoding UTF8

$idx = $idxRaw | ConvertFrom-Json
$types = $idx.value.types
Write-Output "types count: $($types.Count)"

# 只抓有 callPath 的类（即可调用类），接口/枚举只记录
$classNames = @()
foreach ($t in $types) {
    if ($t.PSObject.Properties.Name -contains 'callPath' -and $t.callPath) { $classNames += $t.name }
}
Write-Output "callable classes: $($classNames.Count)"

# 保存类清单
$classNames | Set-Content -Path (Join-Path $root '_classes.txt') -Encoding UTF8

Write-Output '=== 2. fetch each class doc ==='
$ok = 0; $fail = 0
foreach ($cn in $classNames) {
    $dst = Join-Path $root "$cn.json"
    if (Test-Path $dst) { $ok++; continue }
    $raw = (& $cli doc api --class-name $cn 2>&1 | Out-String)
    if ($raw -match '"ok":\s*true') {
        Set-Content -Path $dst -Value $raw -Encoding UTF8
        $ok++
    } else {
        $fail++
        Add-Content -Path (Join-Path $root '_failures.txt') -Value $cn
    }
}
Write-Output "ok=$ok fail=$fail"

Write-Output '=== 3. build method index ==='
$rows = @()
foreach ($f in Get-ChildItem $root -Filter '*.json' | Where-Object { $_.Name -notlike '_*' }) {
    try {
        $j = Get-Content $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
        $cls = $f.BaseName
        $cp = $j.value.callPath
        foreach ($m in $j.value.methods) {
            $rows += [pscustomobject]@{
                class = $cls
                callPath = $cp
                method = $m.name
                visibility = $m.visibility
                comment = $m.comment
            }
        }
    } catch { }
}
$csv = Join-Path $root 'methods.csv'
$rows | Export-Csv -Path $csv -NoTypeInformation -Encoding UTF8
Write-Output "method rows: $($rows.Count) -> $csv"
