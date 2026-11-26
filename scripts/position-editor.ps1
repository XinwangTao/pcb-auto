# 列出 LCEDA 所有窗口（含隐藏），并把真正的编辑器窗口摆到指定位置。
# 踩坑：LCEDA 有多个可见窗口，之前把两个窗口都摆到 0,0 互相遮挡，
# 导致 ffmpeg 录到的是遮罩层而不是编辑器。这里强制分离并验证。
param([int]$X = 0, [int]$Y = 0, [int]$W = 1280, [int]$H = 800)

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinMgr {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool rp);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }

  public class Info { public long H; public int W,Ht,X,Y; public bool Vis; public string Title; }

  public static List<Info> All(uint target) {
    var res = new List<Info>();
    EnumWindows((h,l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != target) return true;
      RECT r; GetWindowRect(h, out r);
      int w = r.R-r.L, ht = r.B-r.T;
      if (w <= 100 || ht <= 100) return true;   // 忽略小工具窗
      var sb = new StringBuilder(512); GetWindowTextW(h, sb, 512);
      res.Add(new Info { H = h.ToInt64(), W = w, Ht = ht, X = r.L, Y = r.T,
                         Vis = IsWindowVisible(h), Title = sb.ToString() });
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
'@

$proc = Get-Process Lceda-pro | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Output '{"ok":false,"reason":"no main window"}'; exit 1 }
$procId = [uint32]$proc.Id

$all = [WinMgr]::All($procId) | Where-Object { $_.Vis }
if (-not $all -or $all.Count -eq 0) { Write-Output '{"ok":false,"reason":"no visible big window"}'; exit 1 }

# 主编辑器 = 面积最大且带菜单的那个（标题通常含 "嘉立创EDA"）
$target = $all | Sort-Object { $_.W * $_.Ht } -Descending | Select-Object -First 1
$th = [IntPtr]$target.H

# 其余可见窗口挪到屏幕外右侧，避免遮挡
$moved = @()
foreach ($item in ($all | Where-Object { $_.H -ne $target.H })) {
  [WinMgr]::MoveWindow([IntPtr]$item.H, 2600, $item.Y, [Math]::Max(400, $item.W), [Math]::Max(300, $item.Ht), $true) | Out-Null
  $moved += "$($item.H)"
}

[WinMgr]::ShowWindow($th, 9) | Out-Null           # SW_RESTORE
[WinMgr]::MoveWindow($th, $X, $Y, $W, $H, $true) | Out-Null
[WinMgr]::SetForegroundWindow($th) | Out-Null
Start-Sleep -Milliseconds 900

$r = New-Object WinMgr+RECT
[WinMgr]::GetWindowRect($th, [ref]$r) | Out-Null

[pscustomobject]@{
  ok      = $true
  hwnd    = $target.H
  pid     = $procId
  x       = $r.L
  y       = $r.T
  w       = ($r.R - $r.L)
  h       = ($r.B - $r.T)
  title   = $target.Title
  movedAside = ($moved -join ',')
  allVisible = ($all | ForEach-Object { "$($_.H):$($_.W)x$($_.Ht)@$($_.X),$($_.Y)" }) -join ' '
} | ConvertTo-Json -Compress
