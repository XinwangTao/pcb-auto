# ============================================================
# 外部程序的定位器 —— 所有脚本共用这一份
#
# 为什么需要它：以前每个脚本各自写死
#     $CLI  = 'E:\APP\lceda-pro\lceda-pro.exe'
#     $Node = 'E:\APP\nodejs24\node.exe'
# 在本机能跑，在别人的机器上第一条命令就失败，而且报错指向一个跟根因无关
# 的地方（「找不到路径」而不是「你没装 EDA」）。
#
# 规则（按优先级，命中即返回）：
#   1. 环境变量        —— CI / 多机部署用这个，不必改脚本
#   2. 常见安装位置    —— 装了但不在 PATH 上的机器
#   3. 通配路径        —— 打包在某个运行时里的解释器
#   4. PATH 上的命令   —— 正常安装的机器走这条
#   全都不中 → 抛一条能直接照做的错，而不是让后面的代码炸在别处
#
# **这里刻意不含任何开发者绝对路径。** 作者机器上 lceda-pro 与 node 都在 PATH 上，
# 所以改造前后的解析结果完全一致 —— 改动只是把「只有本机才成立的硬编码」
# 换成了「在哪都成立的查找」。
#
# 不猜、不假装成功：找不到就停。
# ============================================================

function Resolve-Tool {
    param(
        [Parameter(Mandatory)][string]$Name,   # 人类可读名字，只用于报错
        [string[]]$EnvVars = @(),
        [string[]]$Candidates = @(),
        [string[]]$GlobCandidates = @(),       # 通配（如某运行时里的打包解释器），取排序后第一个
        [string]$Command,
        [string[]]$InstallHint = @(),
        # 只探不用：找不到时返回 $null 而不是抛错。
        # 给「分两轮探测、第二轮才许失败」的场景用（Resolve-Python）。
        [switch]$Quiet
    )

    $tried = [System.Collections.Generic.List[string]]::new()

    foreach ($v in $EnvVars) {
        $val = (Get-Item -Path ("env:" + $v) -ErrorAction SilentlyContinue).Value
        $shown = if ($null -eq $val) { '<未设置>' } else { $val }
        $tried.Add("环境变量 $v = '$shown'")
        if ($val -and (Test-Path -LiteralPath $val -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $val).Path
        }
    }

    foreach ($c in $Candidates) {
        $tried.Add("路径 $c")
        if ($c -and (Test-Path -LiteralPath $c -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $c).Path
        }
    }

    # 通配必须排在 PATH 之前：本机 PATH 上的 python 是 Anaconda，
    # 而这里的量具一直是用 DSH 自带的那个跑的。顺序一变，行为就悄悄变了。
    foreach ($g in $GlobCandidates) {
        $tried.Add("通配 $g")
        $hit = Get-ChildItem -Path $g -ErrorAction SilentlyContinue |
            Where-Object { -not $_.PSIsContainer } |
            Sort-Object -Property FullName |
            Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }

    if ($Command) {
        $tried.Add("PATH 上的 $Command")
        $cmd = Get-Command -Name $Command -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($cmd) { return $cmd.Source }
    }

    $msg = "找不到 $Name。`n按顺序试过：`n  " + ($tried -join "`n  ")
    if ($EnvVars.Count -gt 0) {
        $msg += "`n设置 $($EnvVars[0]) 指向它的可执行文件即可。"
    }
    if ($InstallHint.Count -gt 0) {
        $msg += "`n" + ($InstallHint -join "`n")
    }
    if ($Quiet) { return $null }
    throw $msg
}

# ---- 具体工具 ----------------------------------------------------------

function Resolve-LcedaCli {
    Resolve-Tool -Name '嘉立创 EDA Pro 的 CLI（lceda-pro）' `
        -EnvVars @('PCB_AUTO_LCEDA', 'LCEDA_PRO_EXE') `
        -Candidates @(
            (Join-Path $env:ProgramFiles 'LCEDA Pro\lceda-pro.exe'),
            (Join-Path ${env:ProgramFiles(x86)} 'LCEDA Pro\lceda-pro.exe'),
            (Join-Path $env:LOCALAPPDATA 'Programs\lceda-pro\lceda-pro.exe'),
            (Join-Path $env:LOCALAPPDATA 'LCEDA Pro\lceda-pro.exe'),
            (Join-Path $env:LOCALAPPDATA 'Programs\LCEDA Pro\lceda-pro.exe')
        ) `
        -Command 'lceda-pro' `
        -InstallHint @(
            '本项目只支持嘉立创 EDA Pro 4.1.111 的 CLI（GUI 与 CLI 是同一个 exe）。',
            '装了但不在默认位置时，指一下即可：  $env:PCB_AUTO_LCEDA = "某个位置\lceda-pro.exe"'
        )
}

function Resolve-Node {
    Resolve-Tool -Name 'Node.js（>= 18）' `
        -EnvVars @('PCB_AUTO_NODE') `
        -Candidates @(
            (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
            (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
            (Join-Path $env:LOCALAPPDATA 'fnm_multishells\*\node.exe')
        ) `
        -Command 'node' `
        -InstallHint @('或设置  $env:PCB_AUTO_NODE = "某个位置\node.exe"')
}

function Resolve-Python {
    $hints = @(
        '本项目只有 out\_probe\ 下的量具需要 Python；不跑 census/verify 可以没有它。',
        '或设置  $env:PCB_AUTO_PYTHON = "某个位置\python.exe"'
    )
    $glob = @(
        (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\*\dependencies\python\python.exe'),
        (Join-Path $env:LOCALAPPDATA 'dsh\dsh-runtimes\*\dependencies\python\python.exe')
    )

    # 第一轮：环境变量 → DSH 自带运行时。
    # 这两个必须排在「常见安装位置 / PATH」之前：本机 PATH 上的 python 是 Anaconda，
    # 而这里的量具历来跑在 DSH 自带的那一个上。顺序一变，量具的输出就悄悄变了
    # —— 没人会注意到，因为两者都能跑，只是行为不同。
    $p = Resolve-Tool -Name 'Python（>= 3.9）' -EnvVars @('PCB_AUTO_PYTHON') -GlobCandidates $glob -Quiet
    if ($p) { return $p }

    # 第二轮：正常安装的机器。
    Resolve-Tool -Name 'Python（>= 3.9）' `
        -Candidates @(
            (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'),
            (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe'),
            (Join-Path $env:ProgramFiles 'Python312\python.exe'),
            (Join-Path $env:ProgramFiles 'Python311\python.exe')
        ) `
        -Command 'python' `
        -InstallHint $hints
}
