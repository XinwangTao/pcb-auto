# 弹窗看门狗：EDA 打开工程时会弹出「设置 > 拖动网络名」模态框挡住画面，
# 导致录制出现十几秒死区。该模态框是页面内元素（不是原生窗口），
# 所以用 SendKeys 发 ESC 关闭：有弹窗时能关掉，没弹窗时 ESC 无副作用。
param(
  [int]$IntervalMs = 1500,
  [int]$DurationSec = 400
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class PopWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  public static IntPtr Main(uint target) {
    IntPtr best = IntPtr.Zero; int bestArea = 0;
    EnumWindows((h,l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != target || !IsWindowVisible(h)) return true;
      RECT r; GetWindowRect(h, out r);
      int a = (r.R-r.L)*(r.B-r.T);
      if (a > bestArea) { bestArea = a; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
'@

$proc = Get-Process Lceda-pro -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Output '{"ok":false,"reason":"no EDA"}'; exit 1 }
$h = [PopWin]::Main([uint32]$proc.Id)
if ($h -eq [IntPtr]::Zero) { Write-Output '{"ok":false,"reason":"no window"}'; exit 1 }

$deadline = (Get-Date).AddSeconds($DurationSec)
$sent = 0
while ((Get-Date) -lt $deadline) {
  try {
    [PopWin]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds 120
    [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
    $sent++
  } catch { }
  Start-Sleep -Milliseconds $IntervalMs
}
Write-Output "{""ok"":true,""escSent"":$sent}"
