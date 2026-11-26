# lceda-pro eda API 全量知识库（含方法详细签名）
$ErrorActionPreference = 'Continue'
$cli = 'E:\APP\lceda-pro\lceda-pro.exe'
$root = 'D:\Users\陶鑫旺\Documents\deepseek-harness\default-workspace\pcb-auto\api'
New-Item -ItemType Directory -Force -Path $root | Out-Null
$classDir = Join-Path $root 'classes'
$methodDir = Join-Path $root 'methods'
New-Item -ItemType Directory -Force -Path $classDir | Out-Null
New-Item -ItemType Directory -Force -Path $methodDir | Out-Null

$classNames = Get-Content (Join-Path $root '_classes.txt') -Encoding UTF8

Write-Output "=== fetching $($classNames.Count) class summaries ==="
foreach ($cn in $classNames) {
    $dst = Join-Path $classDir "$cn.json"
    if (Test-Path $dst) { continue }
    $raw = (& $cli doc api --class-name $cn 2>&1 | Out-String)
    Set-Content -Path $dst -Value $raw -Encoding UTF8
}

Write-Output "=== building class/method index ==="
$classRows = @(); $methodRows = @()
foreach ($f in Get-ChildItem $classDir -Filter '*.json') {
    try {
        $j = Get-Content $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
        if (-not $j.ok) { continue }
        $v = $j.value
        $cls = $f.BaseName
        $classRows += [pscustomobject]@{
            class = $cls
            callPath = $v.callPath
            title = $v.title
            remarks = ($v.remarks -replace "`r?`n", ' ')
            methodCount = @($v.methods).Count
        }
        foreach ($m in $v.methods) {
            $methodRows += [pscustomobject]@{
                class = $cls
                callPath = $v.callPath
                method = $m.name
                visibility = $m.visibility
                comment = $m.comment
            }
        }
    } catch { Write-Output "  ERR parse $($f.Name): $($_.Exception.Message)" }
}
$classRows | Sort-Object class | Export-Csv (Join-Path $root 'classes.csv') -NoTypeInformation -Encoding UTF8
$methodRows | Sort-Object class, method | Export-Csv (Join-Path $root 'methods.csv') -NoTypeInformation -Encoding UTF8
Write-Output "classes: $($classRows.Count)  methods: $($methodRows.Count)"

# 常用类的详细签名落盘（含 params 类型与示例）
$keyMethods = @(
    @{ c = 'SCH_SourcePrimitiveComponent'; m = 'add' },
    @{ c = 'SCH_SourcePrimitiveWire'; m = 'add' },
    @{ c = 'SCH_SourcePin'; m = 'setNoConnect' },
    @{ c = 'DMT_Schematic'; m = 'createSchematic' },
    @{ c = 'DMT_Board'; m = 'createBoard' },
    @{ c = 'DMT_Pcb'; m = 'createPcb' },
    @{ c = 'DMT_Project'; m = 'createProject' },
    @{ c = 'PCB_Document'; m = 'importChanges' },
    @{ c = 'LIB_Device'; m = 'batchSearchDevices' },
    @{ c = 'DMT_EditorControl'; m = 'openDocument' }
)
foreach ($km in $keyMethods) {
    $dst = Join-Path $methodDir "$($km.c).$($km.m).json"
    $raw = (& $cli doc api --class-name $km.c --method-name $km.m 2>&1 | Out-String)
    Set-Content -Path $dst -Value $raw -Encoding UTF8
}
Write-Output '=== done ==='
