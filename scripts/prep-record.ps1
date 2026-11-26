# 录制环境准备：关掉遮挡窗口 + 把 EDA 窗口固定在前台，保证录到的就是 EDA 真实操作。
# 踩坑记录：
#   1) 每个 CLI session 都会创建自己的渲染窗口；多个 session 时窗口全叠在 (0,0)，
#      录到的是别的 session 的界面。必须只保留一个 GUI session。
#   2) 资源管理器等前台窗口会遮挡 EDA。需最小化非 EDA 窗口。
#   3) EDA 有外壳 + 文档两个窗口（同一进程），文档窗口才是编辑器。
param(
  [int]$X = 0, [int]$Y = 0, [int]$W = 1280, [int]$H = 800,
  [switch]$MinimizeOthers,
  # 看门狗每 2 秒调一次本脚本把 EDA 拉回前台。若每次都 MoveWindow/ShowWindow，
  # 录下来的画面会每 2 秒抖一下 —— 那不是"AI 在操作"，是录制本身在动。
  # -NoMove 只做置前，不动窗口位置与大小。
  [switch]$NoMove
)

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class RecWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool rp);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }

  public class Info { public long H; public uint Pid; public int W,Ht,X,Y; public string Title; }

  public static List<Info> Visible() {
    var res = new List<Info>();
    EnumWindows((h,l) => {
      if (!IsWindowVisible(h)) return true;
      RECT r; GetWindowRect(h, out r);
      int w = r.R-r.L, ht = r.B-r.T;
      if (w <= 200 || ht <= 150) return true;
      var sb = new StringBuilder(512); GetWindowTextW(h, sb, 512);
      uint pid; GetWindowThreadProcessId(h, out pid);
      res.Add(new Info { H = h.ToInt64(), Pid = pid, W = w, Ht = ht, X = r.L, Y = r.T, Title = sb.ToString() });
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
'@

$edaProcs = @(Get-Process Lceda-pro -ErrorAction SilentlyContinue)
if ($edaProcs.Count -eq 0) { Write-Output '{"ok":false,"reason":"LCEDA not running"}'; exit 1 }
$edaPids = $edaProcs | ForEach-Object { [uint32]$_.Id }

$all = [RecWin]::Visible()
$edaWins = @($all | Where-Object { $edaPids -contains $_.Pid })
if ($edaWins.Count -eq 0) { Write-Output '{"ok":false,"reason":"no EDA window"}'; exit 1 }

# 编辑器 = 面积最大的 EDA 窗口
$main = $edaWins | Sort-Object { $_.W * $_.Ht } -Descending | Select-Object -First 1
$mh = [IntPtr]$main.H

# 最小化所有非 EDA 窗口（资源管理器、终端等遮挡物）
$minCount = 0
if ($MinimizeOthers) {
  foreach ($item in ($all | Where-Object { $edaPids -notcontains $_.Pid })) {
    [RecWin]::ShowWindow([IntPtr]$item.H, 6) | Out-Null    # SW_MINIMIZE
    $minCount++
  }
  Start-Sleep -Milliseconds 400
}

if (-not $NoMove) {
  # 其他 EDA 窗口（外壳/弹窗）挪出录制区
  foreach ($item in ($edaWins | Where-Object { $_.H -ne $main.H })) {
    [RecWin]::MoveWindow([IntPtr]$item.H, 3000, 0, [Math]::Max(400,$item.W), [Math]::Max(300,$item.Ht), $true) | Out-Null
  }

  # 主窗口：恢复 + 定位 + 置顶（HWND_TOPMOST=-1，SWP_SHOWWINDOW=0x40）
  [RecWin]::ShowWindow($mh, 9) | Out-Null
  [RecWin]::MoveWindow($mh, $X, $Y, $W, $H, $true) | Out-Null
  [RecWin]::SetWindowPos($mh, [IntPtr](-1), $X, $Y, $W, $H, 0x40) | Out-Null
}
[RecWin]::BringWindowToTop($mh) | Out-Null
[RecWin]::SetForegroundWindow($mh) | Out-Null
Start-Sleep -Milliseconds 800

$r = New-Object RecWin+RECT
[RecWin]::GetWindowRect($mh, [ref]$r) | Out-Null
$fg = [RecWin]::GetForegroundWindow()

[pscustomobject]@{
  ok        = $true
  hwnd      = $main.H
  pid       = $main.Pid
  x         = $r.L
  y         = $r.T
  w         = ($r.R - $r.L)
  h         = ($r.B - $r.T)
  minimized = $minCount
  isForeground = ($fg.ToInt64() -eq $main.H)
  edaWindows = ($edaWins | ForEach-Object { "$($_.H):$($_.W)x$($_.Ht)" }) -join ' '
} | ConvertTo-Json -Compress
