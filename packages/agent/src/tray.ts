// Where a person sees the agent. Windows: a tray icon from Windows' own signed PowerShell (no extra program to install or
// sign): a green, amber or red dot, the headline as its tooltip, a menu with the one fix, and a balloon when it turns amber or
// red. It asks the agent's local channel every 30 seconds and closes itself when the agent stops. macOS and Linux: a system
// notification when the state gets worse, and once more when it recovers.

import { spawn, type ChildProcess } from "node:child_process";
import { AGENT_FILE, TOKEN_HEADER } from "./ipc.js";
import type { Health, HealthLevel } from "./health.js";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** The tray script. The Scopebond home and the agent's process id reach it as base64 data, never as code. */
export function trayScript(home: string, agentPid: number): string {
  return `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
function T($s) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) }
$endpointFile = Join-Path (T '${b64(home)}') '${AGENT_FILE}'
$agentPid = ${Math.trunc(agentPid)}
function Dot($color) {
  $b = New-Object Drawing.Bitmap 16, 16
  $g = [Drawing.Graphics]::FromImage($b)
  $g.SmoothingMode = 'AntiAlias'
  $g.FillEllipse((New-Object Drawing.SolidBrush $color), 2, 2, 12, 12)
  $g.Dispose()
  [Drawing.Icon]::FromHandle($b.GetHicon())
}
$icons = @{ green = (Dot ([Drawing.Color]::FromArgb(46, 160, 67))); amber = (Dot ([Drawing.Color]::FromArgb(219, 154, 4))); red = (Dot ([Drawing.Color]::FromArgb(207, 34, 46))) }
$tray = New-Object Windows.Forms.NotifyIcon
$tray.Icon = $icons.amber
$tray.Text = 'Scopebond'
$tray.Visible = $true
$menu = New-Object Windows.Forms.ContextMenuStrip
$tray.ContextMenuStrip = $menu
$script:level = ''
$script:fix = $null
function Call($method, $route) {
  $e = Get-Content -Raw $endpointFile | ConvertFrom-Json
  $uri = 'http://127.0.0.1:' + $e.port + $route
  $headers = @{ '${TOKEN_HEADER}' = $e.token }
  if ($method -eq 'POST') { Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 300 }
  else { Invoke-RestMethod -Method Get -Uri $uri -Headers $headers -TimeoutSec 10 }
}
function Refresh {
  if (-not (Get-Process -Id $agentPid)) { $tray.Visible = $false; [Windows.Forms.Application]::Exit(); return }
  try { $h = (Call 'GET' '/status').health } catch { $h = $null }
  if (-not $h) { $h = @{ level = 'red'; headline = 'The Scopebond Agent is not answering'; fix = $null; hint = $null } }
  $tray.Icon = $icons[$h.level]
  $tip = 'Scopebond: ' + $h.headline
  $tray.Text = $(if ($tip.Length -gt 63) { $tip.Substring(0, 60) + '...' } else { $tip })
  $menu.Items.Clear()
  $head = $menu.Items.Add($h.headline); $head.Enabled = $false
  if ($h.hint) { $hint = $menu.Items.Add($h.hint); $hint.Enabled = $false }
  if ($h.fix) {
    $route = $h.fix.route
    $item = $menu.Items.Add($h.fix.label)
    $item.Add_Click({ try { Call 'POST' $route | Out-Null } catch {} ; Refresh }.GetNewClosure())
  }
  [void]$menu.Items.Add('-')
  $check = $menu.Items.Add('Check now'); $check.Add_Click({ try { Call 'POST' '/maintain' | Out-Null } catch {} ; Refresh })
  $quit = $menu.Items.Add('Hide this icon'); $quit.Add_Click({ $tray.Visible = $false; [Windows.Forms.Application]::Exit() })
  if ($script:level -ne $h.level -and $h.level -ne 'green' -and $script:level -ne '') { $tray.ShowBalloonTip(8000, 'Scopebond', $h.headline, $(if ($h.level -eq 'red') { 'Error' } else { 'Warning' })) }
  $script:level = $h.level
}
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 30000
$timer.Add_Tick({ Refresh })
$timer.Start()
Refresh
[Windows.Forms.Application]::Run()
$tray.Dispose()
`;
}

/** Start the tray icon for this agent (Windows only). Returns the process so the agent can close it when it stops. */
export function startTray(home: string, agentPid = process.pid): ChildProcess | null {
  if (process.platform !== "win32") return null;
  try {
    const encoded = Buffer.from(trayScript(home, agentPid), "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-EncodedCommand", encoded], { stdio: "ignore", windowsHide: true });
    child.on("error", () => { /* no PowerShell, or blocked: the agent keeps working without an icon */ });
    return child;
  } catch { return null; }
}

const RANK: Record<HealthLevel, number> = { green: 0, amber: 1, red: 2 };

/** macOS and Linux: notify when the state gets worse, and once when it is green again. Returns whether it notified. */
export function notifyChange(previous: HealthLevel | null, health: Health, run: typeof spawn = spawn): boolean {
  if (process.platform === "win32" || previous === null || previous === health.level) return false;
  if (RANK[health.level] < RANK[previous] && health.level !== "green") return false;
  const text = health.level === "green" ? "Working again: " + health.headline : health.headline + (health.hint ? `. ${health.hint}` : "");
  try {
    const child = process.platform === "darwin"
      ? run("osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", "Scopebond", text], { stdio: "ignore" })
      : run("notify-send", ["Scopebond", text], { stdio: "ignore" });
    child.on("error", () => { /* no notification service */ });
    return true;
  } catch { return false; }
}

