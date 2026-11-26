# 定位 LCEDA 文档窗口（真实编辑器），把它摆到固定位置，供 ffmpeg 定点录制。
# 关键事实：LCEDA 有外壳窗口(全屏) + 文档窗口(内层,有自己的菜单栏)两层，
# 必须录内层，否则画面里全是启动器外壳。
param(
  [int]$X = 0,
  [int]$Y = 0,
  [int]$W = 1280,
  [int]$H = 860
)

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class EdWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }

  // 返回所有可见大窗口：hwnd|w|h|class|title
  public static List<string> List(uint target) {
    var res = new List<string>();
    EnumWindows((h,l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != target) return true;
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512); GetWindowTextW(h, sb, 512);
      var cn = new StringBuilder(256); GetClassNameW(h, cn, 256);
      RECT r; GetWindowRect(h, out r);
      int w = r.R-r.L, ht = r.B-r.T;
      if (w > 300 && ht > 200)
        res.Add(h.ToInt64() + "|" + w + "x" + ht + "|" + cn + "|" + sb);
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
'@

# 找主进程（有主窗口的那个）
$proc = Get-Process Lceda-pro | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Output '{"ok":false,"reason":"no Lceda-pro main window"}'; exit 1 }
$procId = [uint32]$proc.Id

$wins = [EdWin]::List($procId)
# 文档窗口 = 面积较小的那个大窗口（外壳是全屏）
$parsed = @()
foreach ($item in $wins) {
  $parts = $item -split '\|'
  $hwnd = [int64]$parts[0]
  $wh = $parts[1] -split 'x'
  $parsed += [pscustomobject]@{ Hwnd = $hwnd; W = [int]$wh[0]; H = [int]$wh[1]; Cls = $parts[2]; Title = $parts[3] }
}
if (-not $parsed.Count) { Write-Output '{"ok":false,"reason":"no visible window"}'; exit 1 }

$doc = $parsed | Sort-Object { $_.W * $_.H } | Select-Object -First 1
$h = [IntPtr]$doc.Hwnd

# 摆到固定位置，保证 ffmpeg 的 offset 永远正确
[EdWin]::ShowWindow($h, 9) | Out-Null      # SW_RESTORE
[EdWin]::MoveWindow($h, $X, $Y, $W, $H, $true) | Out-Null
[EdWin]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 700

$r = New-Object EdWin+RECT
[EdWin]::GetWindowRect($h, [ref]$r) | Out-Null

[pscustomobject]@{
  ok      = $true
  hwnd    = $doc.Hwnd
  pid     = $procId
  rect    = "$($r.L),$($r.T),$($r.R),$($r.B)"
  w       = ($r.R - $r.L)
  h       = ($r.B - $r.T)
  allWins = ($parsed | ForEach-Object { "$($_.Hwnd):$($_.W)x$($_.H)" }) -join ' '
} | ConvertTo-Json -Compress
