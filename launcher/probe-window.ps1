# Checks the frameless window without showing it or touching the mouse: starts the program
# off screen (its --capture test mode, on a port of its own), then asks the window what each
# part of it is, the way Windows asks before it moves or resizes a window.
#
#   pwsh launcher\probe-window.ps1 [-Exe <path to DD2SaveManager.exe>]
#
# What a healthy window reports:
#   - the client area starts 0 px from the top edge (the page owns the title bar's space),
#     with the usual frame left, right and below (8 px at 100% scale);
#   - the left, right and bottom edges and both bottom corners answer as resize borders;
#   - "drag areas" lists the parts of the page marked app-region: drag (WebView2 lays a small
#     window over each). They answer CAPTION, and TOP along the window's top edge; the language
#     menu and the window buttons must not be inside any of them.
# What it cannot check: the move, resize, snap and maximize themselves. Those need a person.
param(
  [string]$Exe = (Join-Path (Split-Path $PSScriptRoot -Parent) 'DD2SaveManager.exe'),
  [int]$Port = 47833
)

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class Probe {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);

  public static IntPtr Find(string title, uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      var s = new StringBuilder(256); GetWindowText(h, s, 256);
      uint owner; GetWindowThreadProcessId(h, out owner);
      if (s.ToString() == title && owner == pid) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static List<IntPtr> Children(IntPtr parent) {
    var list = new List<IntPtr>();
    EnumChildWindows(parent, (h, p) => { list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static string Class(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  // WM_NCHITTEST: "what is at this point of the screen?"
  public static int Hit(IntPtr h, int x, int y) {
    IntPtr result;
    IntPtr l = (IntPtr)(((y & 0xFFFF) << 16) | (x & 0xFFFF));
    return SendMessageTimeout(h, 0x0084, IntPtr.Zero, l, 0x0002, 2000, out result) == IntPtr.Zero ? -99 : (int)(long)result;
  }
}
"@

$names = @{ 0 = 'nowhere'; 1 = 'content'; 2 = 'CAPTION'; 10 = 'LEFT'; 11 = 'RIGHT'; 12 = 'TOP'; 13 = 'TOPLEFT'; 14 = 'TOPRIGHT'; 15 = 'BOTTOM'; 16 = 'BOTTOMLEFT'; 17 = 'BOTTOMRIGHT'; -1 = 'transparent'; -99 = 'no answer' }
function Name($code) { if ($names.ContainsKey($code)) { $names[$code] } else { "code $code" } }

$work = Join-Path ([IO.Path]::GetTempPath()) 'dd2sm-probe'
New-Item -ItemType Directory -Force $work | Out-Null
Set-Content (Join-Path $work 'hold.js') 'void 0;'
$launcher = Start-Process -FilePath $Exe -PassThru -ArgumentList @('--port', $Port, '--capture', (Join-Path $work 'window.png'), '--capture-script', (Join-Path $work 'hold.js'), '--capture-delay', '20000')

[void][Probe]::SetThreadDpiAwarenessContext([IntPtr](-4))
$top = [IntPtr]::Zero
for ($i = 0; $i -lt 60 -and $top -eq [IntPtr]::Zero; $i++) {
  Start-Sleep -Milliseconds 500
  $top = [Probe]::Find('DD2 Save Manager', $launcher.Id)
}
if ($top -eq [IntPtr]::Zero) { 'The window did not appear.'; exit 1 }
Start-Sleep -Seconds 8  # the page loads and lays itself out

$w = New-Object Probe+RECT; $c = New-Object Probe+RECT; $o = New-Object Probe+POINT
[void][Probe]::GetWindowRect($top, [ref]$w); [void][Probe]::GetClientRect($top, [ref]$c); [void][Probe]::ClientToScreen($top, [ref]$o)
"scale   $([Probe]::GetDpiForWindow($top) / 96)"
"client  starts $($o.X - $w.L) px from the left edge and $($o.Y - $w.T) px from the top edge; $($c.R) x $($c.B)"
"frame   right $($w.R - ($o.X + $c.R)) px, bottom $($w.B - ($o.Y + $c.B)) px"
$midX = [int](($w.L + $w.R) / 2); $midY = [int](($w.T + $w.B) / 2)
'borders'
foreach ($spot in @(@('left edge', ($w.L + 2), $midY), @('right edge', ($w.R - 3), $midY), @('bottom edge', $midX, ($w.B - 3)), @('bottom-left corner', ($w.L + 2), ($w.B - 3)), @('bottom-right corner', ($w.R - 3), ($w.B - 3)))) {
  "  {0,-20} {1}" -f $spot[0], (Name ([Probe]::Hit($top, $spot[1], $spot[2])))
}
'drag areas (x, y, width x height inside the window; what the middle and the top row answer)'
foreach ($child in [Probe]::Children($top)) {
  if ([Probe]::Class($child) -ne 'Chrome_WidgetWin_0') { continue }
  $r = New-Object Probe+RECT; [void][Probe]::GetWindowRect($child, [ref]$r)
  if (($r.R - $r.L) -ge $c.R -and ($r.B - $r.T) -ge $c.B) { continue }  # the page itself
  $mid = Name ([Probe]::Hit($child, [int](($r.L + $r.R) / 2), [int](($r.T + $r.B) / 2)))
  $first = Name ([Probe]::Hit($child, [int](($r.L + $r.R) / 2), $r.T))
  "  {0,5},{1,3}  {2,4} x {3,-3}  {4}, top row {5}" -f ($r.L - $o.X), ($r.T - $o.Y), ($r.R - $r.L), ($r.B - $r.T), $mid, $first
}
[void]$launcher.WaitForExit(60000)
"picture of the window: $(Join-Path $work 'window.png')"
