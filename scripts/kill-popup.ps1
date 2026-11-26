# 用窗口消息直接投递按键，不依赖前台焦点。
# 背景：EDA 是 Chromium 内嵌页面，弹「设置 > 拖动网络名」模态框会一直挡住画面。
# SendKeys 需要窗口真的在前台（实测 isForeground 常为 false，投递无效）。
# 这里改用 PostMessage 把 ESC 直接发到目标窗口及其子窗口，绕开焦点依赖。
param(
  [long]$Hwnd = 0,
  [int]$DurationSec = 60,
  [int]$IntervalMs = 2500
)

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class KeyPost {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }

  const uint WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_CHAR = 0x0102;

  public static IntPtr Largest(uint targetPid) {
    IntPtr best = IntPtr.Zero; int bestArea = 0;
    EnumWindows((h,l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != targetPid || !IsWindowVisible(h)) return true;
      RECT r; GetWindowRect(h, out r);
      int a = (r.R-r.L)*(r.B-r.T);
      if (a > bestArea) { bestArea = a; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  public static List<IntPtr> Children(IntPtr parent) {
    var res = new List<IntPtr>();
    EnumChildWindows(parent, (h,l) => { if (IsWindowVisible(h)) res.Add(h); return true; }, IntPtr.Zero);
    return res;
  }

  public static void SendEsc(IntPtr h) {
    PostMessageW(h, WM_KEYDOWN, (IntPtr)0x1B, (IntPtr)0x00010001);
    PostMessageW(h, WM_KEYUP,   (IntPtr)0x1B, unchecked((IntPtr)(int)0xC0010001));
  }
}
'@

$proc = Get-Process Lceda-pro -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Output '{"ok":false,"reason":"no EDA"}'; exit 1 }

$h = if ($Hwnd -ne 0) { [IntPtr]$Hwnd } else { [KeyPost]::Largest([uint32]$proc.Id) }
if ($h -eq [IntPtr]::Zero) { Write-Output '{"ok":false,"reason":"no window"}'; exit 1 }

$deadline = (Get-Date).AddSeconds($DurationSec)
$rounds = 0
while ((Get-Date) -lt $deadline) {
  # 先尝试正常激活 + ESC
  try {
    [KeyPost]::ShowWindow($h, 9) | Out-Null
    [KeyPost]::SetForegroundWindow($h) | Out-Null
  } catch { }
  Start-Sleep -Milliseconds 100

  # 关键：把 ESC 同时投递给主窗口和所有可见子窗口（Chromium 渲染窗口是子窗口）
  $targets = @($h) + [KeyPost]::Children($h)
  foreach ($t in $targets) { try { [KeyPost]::SendEsc($t) } catch { } }
  $rounds++
  Start-Sleep -Milliseconds $IntervalMs
}
Write-Output "{""ok"":true,""rounds"":$rounds,""targets"":$($targets.Count)}"
