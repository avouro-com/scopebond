// Where a person sees the agent. Windows: a tray icon from Windows' own signed PowerShell (no extra program to install or
// sign). It draws the "S" tile with a status badge (D143: shape and colour together, no seal), shows the agent's tray model
// (`GET /tray`: one headline, the rows that have data, the one fix, the actions that apply now), says what "Check now" found,
// and shows a balloon only when the state gets worse (after five minutes for "needs attention", so sleep and wake do not
// flap) or recovers, as the person's notification setting allows. It asks the agent's local channel every 30 seconds and
// closes itself when the agent stops. macOS and Linux: a system notification when the state gets worse, and once more when
// it recovers.

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
$home0 = T '${b64(home)}'
$endpointFile = Join-Path $home0 '${AGENT_FILE}'
$agentPid = ${Math.trunc(agentPid)}
function C($hex) { [Drawing.ColorTranslator]::FromHtml($hex) }
# The "S" tile (navy; slate when disconnected) with a badge: grey dash offline, amber "!" attention, red x problem,
# blue arrow working, a slash when disconnected, none when protected.
function Tile($state) {
  $b = New-Object Drawing.Bitmap 32, 32
  $g = [Drawing.Graphics]::FromImage($b)
  $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
  $tile = $(if ($state -eq 'disconnected') { C '#57606A' } else { C '#1B3A5C' })
  $path = New-Object Drawing.Drawing2D.GraphicsPath
  $r = 8; $path.AddArc(1, 1, $r * 2, $r * 2, 180, 90); $path.AddArc(31 - $r * 2, 1, $r * 2, $r * 2, 270, 90)
  $path.AddArc(31 - $r * 2, 31 - $r * 2, $r * 2, $r * 2, 0, 90); $path.AddArc(1, 31 - $r * 2, $r * 2, $r * 2, 90, 90); $path.CloseFigure()
  $g.FillPath((New-Object Drawing.SolidBrush $tile), $path)
  $font = New-Object Drawing.Font('Segoe UI', 17, [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object Drawing.StringFormat; $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
  $g.DrawString('S', $font, (New-Object Drawing.SolidBrush (C '#F7F4EE')), (New-Object Drawing.RectangleF(0, 0, 30, 32)), $fmt)
  $white = New-Object Drawing.Pen((C '#FFFFFF'), 2.2); $white.StartCap = 'Round'; $white.EndCap = 'Round'
  if ($state -eq 'disconnected') { $g.DrawLine((New-Object Drawing.Pen((C '#F7F4EE'), 2)), 6, 26, 26, 6) }
  elseif ($state -ne 'protected') {
    $fill = @{ offline = '#6E7781'; attention = '#DB9A04'; problem = '#CF222E'; working = '#0969DA' }[$state]
    $g.FillEllipse((New-Object Drawing.SolidBrush (C $fill)), 17, 17, 14, 14)
    $g.DrawEllipse((New-Object Drawing.Pen((C '#F7F4EE'), 1.5)), 17, 17, 14, 14)
    switch ($state) {
      'offline' { $g.DrawLine($white, 21, 24, 27, 24) }
      'attention' { $dark = New-Object Drawing.Pen((C '#1F1A12'), 2.2); $dark.StartCap = 'Round'; $dark.EndCap = 'Round'; $g.DrawLine($dark, 24, 20, 24, 25); $g.FillEllipse((New-Object Drawing.SolidBrush (C '#1F1A12')), 23, 26.5, 2.4, 2.4) }
      'problem' { $g.DrawLine($white, 21.5, 21.5, 26.5, 26.5); $g.DrawLine($white, 26.5, 21.5, 21.5, 26.5) }
      'working' { $g.DrawArc($white, 20.5, 20.5, 7, 7, 300, 280) }
    }
  }
  $g.Dispose()
  [Drawing.Icon]::FromHandle($b.GetHicon())
}
$icons = @{}
foreach ($s in 'protected', 'working', 'offline', 'attention', 'problem', 'disconnected') { $icons[$s] = Tile $s }
$tray = New-Object Windows.Forms.NotifyIcon
$tray.Icon = $icons.offline
$tray.Text = 'Scopebond'
$tray.Visible = $true
$menu = New-Object Windows.Forms.ContextMenuStrip
$tray.ContextMenuStrip = $menu
$script:state = ''
$script:worseSince = $null
$script:told = ''
$script:settings = @{ notifications = 'problems' }
function Call($method, $route, $body) {
  $e = Get-Content -Raw $endpointFile | ConvertFrom-Json
  $uri = 'http://127.0.0.1:' + $e.port + $route
  $headers = @{ '${TOKEN_HEADER}' = $e.token }
  if ($method -eq 'POST') { $json = $(if ($body) { $body | ConvertTo-Json -Compress } else { '{}' }); Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -ContentType 'application/json' -Body $json -TimeoutSec 300 }
  else { Invoke-RestMethod -Method Get -Uri $uri -Headers $headers -TimeoutSec 10 }
}
function Tell($title, $text, $kind) { if ($script:settings.notifications -ne 'off') { $tray.ShowBalloonTip(6000, $title, $text, $kind) } }
function Item($parent, $text, $enabled, $action) {
  $i = $parent.Items.Add($text); $i.Enabled = $enabled
  if ($action) { $i.Add_Click($action) }
  $i
}
function Run($route) { try { Call 'POST' $route | Out-Null } catch {} ; Refresh }
function Refresh {
  if (-not (Get-Process -Id $agentPid)) { $tray.Visible = $false; [Windows.Forms.Application]::Exit(); return }
  try { $answer = Call 'GET' '/tray' } catch { $answer = $null }
  if ($answer) { $m = $answer.tray; if ($answer.settings) { $script:settings = $answer.settings } }
  else { $m = [pscustomobject]@{ state = 'problem'; headline = 'The Scopebond Agent is not answering'; tooltip = 'Scopebond — the agent is not answering'; rows = @(); fix = $null; actions = @(); hint = $null; recent_blocks = @() } }
  $tray.Icon = $icons[$m.state]
  $tray.Text = $(if ($m.tooltip.Length -gt 63) { $m.tooltip.Substring(0, 62) } else { $m.tooltip })
  $menu.Items.Clear()
  $head = Item $menu ('Scopebond — ' + $m.headline) $false $null
  $head.Font = New-Object Drawing.Font($head.Font, [Drawing.FontStyle]::Bold)
  foreach ($row in $m.rows) { [void](Item $menu ('    ' + $row.label + ':  ' + $row.value) $false $null) }
  if ($m.hint) { [void](Item $menu $m.hint $false $null) }
  [void]$menu.Items.Add('-')
  if ($m.fix) { $route = $m.fix.route; $f = Item $menu $m.fix.label $true ({ Run $route }.GetNewClosure()); $f.Font = New-Object Drawing.Font($f.Font, [Drawing.FontStyle]::Bold) }
  foreach ($a in $m.actions) {
    $route = $a.route
    if ($route -eq '/check') { [void](Item $menu $a.label $true ({ try { $r = Call 'POST' '/check'; Tell 'Scopebond' $r.text 'Info' } catch { Tell 'Scopebond' 'Check could not reach the Scopebond Agent' 'Warning' } ; Refresh })) }
    else { [void](Item $menu $a.label $true ({ Run $route }.GetNewClosure())) }
  }
  if ($m.recent_blocks.Count -gt 0) {
    [void]$menu.Items.Add('-')
    $blocks = $menu.Items.Add('Recently blocked')
    foreach ($b in $m.recent_blocks) { $when = $(try { ([datetime]$b.at).ToLocalTime().ToString('HH:mm') } catch { '' }); [void]$blocks.DropDownItems.Add($b.summary + '   ' + $when).Enabled }
  }
  [void]$menu.Items.Add('-')
  $notes = $menu.Items.Add('Notifications')
  foreach ($choice in @(@('all', 'All'), @('problems', 'Problems only'), @('off', 'Off'))) {
    $value = $choice[0]
    $n = $notes.DropDownItems.Add($choice[1]); $n.Checked = ($script:settings.notifications -eq $value)
    $n.Add_Click({ try { $script:settings = (Call 'POST' '/settings' @{ notifications = $value }).settings } catch {} ; Refresh }.GetNewClosure())
  }
  $help = $menu.Items.Add('Help')
  [void]$help.DropDownItems.Add('Copy diagnostics', $null, { try { (Call 'GET' '/status') | ConvertTo-Json -Depth 8 | Set-Clipboard; Tell 'Scopebond' 'Diagnostics copied (no keys or credentials)' 'Info' } catch {} })
  [void]$help.DropDownItems.Add('Open the Scopebond folder', $null, { Start-Process explorer.exe $home0 })
  [void]$help.DropDownItems.Add('Scopebond documentation', $null, { Start-Process 'https://scopebond.com/documentation' })
  [void]$help.DropDownItems.Add('About', $null, { try { $st = Call 'GET' '/status'; [Windows.Forms.MessageBox]::Show(('Scopebond Agent' + [Environment]::NewLine + 'Publisher: Avouro LLC' + [Environment]::NewLine + 'Agent: ' + $st.agent.version + [Environment]::NewLine + 'Hook: ' + $st.version + [Environment]::NewLine + 'Computer: ' + $st.identity.installation_id), 'About Scopebond') | Out-Null } catch {} })
  [void](Item $menu 'Hide icon' $true { $tray.Visible = $false; [Windows.Forms.Application]::Exit() })
  # Balloons: worse states as the setting allows ("needs attention" only after five minutes), and once when protected again.
  $rank = @{ protected = 0; working = 0; offline = 1; attention = 2; disconnected = 3; problem = 3 }
  if ($rank[$m.state] -ge 2) { if (-not $script:worseSince) { $script:worseSince = Get-Date } } else { $script:worseSince = $null }
  $due = $script:worseSince -and ($m.state -ne 'attention' -or ((Get-Date) - $script:worseSince).TotalMinutes -ge 5)
  if ($due -and $script:told -ne $m.state) { Tell 'Scopebond' $m.headline $(if ($rank[$m.state] -ge 3) { 'Error' } else { 'Warning' }); $script:told = $m.state }
  elseif ($m.state -eq 'protected' -and $script:told -ne '' -and $script:told -ne 'protected') { Tell 'Scopebond' 'Scopebond is protecting again' 'Info'; $script:told = '' }
  $script:state = $m.state
}
$tray.Add_MouseClick({ if ($_.Button -eq 'Left') { Refresh; $m = [Windows.Forms.NotifyIcon].GetMethod('ShowContextMenu', [Reflection.BindingFlags]'Instance,NonPublic'); $m.Invoke($tray, $null) } })
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

