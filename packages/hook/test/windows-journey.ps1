<#
.SYNOPSIS
  The Windows clean-machine journey: what a person on Windows types, the way they type it.

.DESCRIPTION
  Runs in Windows PowerShell 5.1 and PowerShell 7 under the Windows client default execution
  policy (Restricted, set for this process), using only the commands Scopebond publishes:
  npx.cmd, npm.cmd and scopebond-agent.cmd. A fake workspace (fake-cloud.mjs) stands in for the
  Cloud and approves the sign-in code the way a person would in the browser.

    1. Node is new enough, and plain `npx` really is blocked by the execution policy.
    2. npx.cmd ... login <workspace>: a code, approval, cloud.json in the user's home, the hook
       in the user-level Claude Code settings.
    3. One action through the hook command Claude Code would run; one record delivered.
    4. npm.cmd install -g the agent; scopebond-agent.cmd autostart on: the Run key and launcher,
       the agent running, its self-check passing, status saying so.
    5. scopebond-agent.cmd autostart off and npm.cmd uninstall -g: nothing left behind.

  Every command the script runs must end in .cmd, and every command Scopebond prints for the
  person to run (hints, fixes, next steps) is checked for the same: plain `npx`, `npm` or
  `scopebond-agent` fails the journey, because PowerShell blocks their .ps1 shims.

.PARAMETER HookPackage
  The hook as an npm package spec: a packed tarball path, or @scopebond/hook@<version>.
.PARAMETER AgentPackage
  The agent as an npm package spec: a packed tarball path, or @scopebond/agent@<version>.
.PARAMETER SkipAgent
  Run steps 1-3 only (for a computer whose own agent autostart must not be touched).
.PARAMETER IsolatedHome
  Use a throwaway user profile folder (USERPROFILE, HOME, APPDATA) instead of the real one.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $HookPackage,
  [string] $AgentPackage = '',
  [switch] $SkipAgent,
  [switch] $IsolatedHome
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

# npx runs a bare path as a program; a packed tarball is named as a package with file:.
function ConvertTo-PackageSpec([string] $Spec) {
  if ($Spec -and (Test-Path -LiteralPath $Spec)) { return 'file:' + ((Resolve-Path -LiteralPath $Spec).Path -replace '\\', '/') }
  return $Spec
}
$HookPackage = ConvertTo-PackageSpec $HookPackage
$AgentPackage = ConvertTo-PackageSpec $AgentPackage

$script:Failures = New-Object System.Collections.Generic.List[string]
$script:Printed = New-Object System.Collections.Generic.List[string]

function Pass([string] $Name) { Write-Host "  ok  $Name" }
function Fail([string] $Name, [string] $Detail) {
  $script:Failures.Add($Name)
  Write-Host "  FAIL $Name"
  if ($Detail) { Write-Host ("       " + ($Detail -replace "`n", "`n       ")) }
}
function Check([string] $Name, [scriptblock] $Body) {
  try { & $Body; Pass $Name } catch { Fail $Name $_.Exception.Message }
}
function Assert([bool] $Condition, [string] $Message) { if (-not $Condition) { throw $Message } }

# A published command, run the way a person runs it. Refuses any name without .cmd.
function Invoke-Published {
  param([string] $Command, [string[]] $Arguments = @(), [string] $InputText = $null)
  if ($Command -notmatch '\.cmd$') { throw "a published Windows command must end in .cmd: $Command" }
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'   # Windows PowerShell turns a native command's stderr into errors
  try {
    if ($InputText) { $output = $InputText | & $Command @Arguments 2>&1 }
    else { $output = & $Command @Arguments 2>&1 }
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previous }
  $text = (@($output) | ForEach-Object { "$_" }) -join "`n"
  $script:Printed.Add($text)
  return [pscustomobject]@{ Code = $code; Out = $text }
}

# Commands Scopebond prints for the person to run must be the .cmd form on Windows.
$PlainCommand = '(?m)(?:^|[\s`''"(:])(npx|npm|scopebond-agent)\s+(?:-y\b|-g\b|install\b|i\b|exec\b|uninstall\b|autostart\b|status\b|flush\b|check\b|repair\b|run\b|setup\b)'
function Find-PlainCommands([string] $Text) {
  $found = @()
  foreach ($m in [regex]::Matches($Text, $PlainCommand)) { $found += $m.Value.Trim() }
  return $found
}

function Get-RunValue {
  $value = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'ScopebondAgent' -ErrorAction SilentlyContinue
  if ($value) { return $value.ScopebondAgent }
  return $null
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("sb-journey-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work | Out-Null
if ($IsolatedHome) {
  $profileDir = Join-Path $work 'profile'
  New-Item -ItemType Directory -Path (Join-Path $profileDir 'AppData\Roaming\npm') -Force | Out-Null
  $env:USERPROFILE = $profileDir
  $env:HOME = $profileDir
  $env:APPDATA = Join-Path $profileDir 'AppData\Roaming'
  $env:npm_config_prefix = Join-Path $env:APPDATA 'npm'
  $env:PATH = (Join-Path $env:APPDATA 'npm') + ';' + $env:PATH
}
Remove-Item Env:SCOPEBOND_HOME, Env:SCOPEBOND_HOOK_DIR, Env:CLAUDECODE -ErrorAction SilentlyContinue
$sbHome = Join-Path $env:USERPROFILE '.scopebond'
# A person's first terminal often opens in a project folder; the journey runs from one.
$project = Join-Path $work 'my-project'
New-Item -ItemType Directory -Path $project | Out-Null
Set-Location $project

Write-Host "Windows journey: PowerShell $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition)), user $env:USERNAME, home $env:USERPROFILE"

# The fake workspace, as its own process.
$urlFile = Join-Path $work 'cloud-url.txt'
$fake = Start-Process -FilePath 'node.exe' -ArgumentList @("`"$PSScriptRoot\fake-cloud.mjs`"", '--url-file', "`"$urlFile`"", '--auto-approve') -PassThru -WindowStyle Hidden
for ($i = 0; $i -lt 50 -and -not (Test-Path $urlFile); $i++) { Start-Sleep -Milliseconds 200 }
if (-not (Test-Path $urlFile)) { throw 'the fake workspace did not start' }
$cloud = (Get-Content $urlFile -Raw).Trim()
function Get-CloudState { Invoke-RestMethod -Uri "$cloud/__test/state" }

try {
  # 1. Preconditions a person meets first.
  Check 'Node is 22.13 or newer' {
    $v = [version]((& node.exe -p 'process.versions.node').Trim())
    Assert ($v -ge [version]'22.13.0') "Node $v is too old for Scopebond (needs 22.13 or newer)"
  }

  Set-ExecutionPolicy -Scope Process -ExecutionPolicy Restricted -Force
  Check 'the Windows client default execution policy (Restricted) is in force' {
    $effective = Get-ExecutionPolicy
    Assert ($effective -eq 'Restricted') "effective policy is $effective; a Group Policy overrides the process scope"
  }
  Check 'plain npx is blocked by that policy, which is why every command is written npx.cmd' {
    $shim = Get-Command npx -CommandType ExternalScript -ErrorAction SilentlyContinue
    if (-not $shim) { Write-Host '       (no npx.ps1 on this computer; nothing to block)'; return }
    $blocked = $false
    try { & npx --version | Out-Null } catch { $blocked = $_.FullyQualifiedErrorId -match 'UnauthorizedAccess' -or $_.Exception -is [System.Management.Automation.PSSecurityException] }
    Assert $blocked 'npx.ps1 ran under the Restricted policy; this check proves nothing'
  }

  # 2. Sign in with a code.
  $login = $null
  Check 'npx.cmd ... login: a code, approval, and cloud.json in the user home (not the project folder)' {
    $script:login = Invoke-Published 'npx.cmd' @('-y', $HookPackage, 'login', $cloud, '--claude')
    $state = Get-CloudState
    Assert ($script:login.Code -eq 0) "login exited $($script:login.Code):`n$($script:login.Out)"
    Assert (@($state.approved_codes).Count -eq 1) "the workspace approved $(@($state.approved_codes).Count) code(s):`n$($script:login.Out)"
    Assert ($script:login.Out -match [regex]::Escape($state.approved_codes[0])) 'the CLI did not show the code the workspace approved'
    Assert (Test-Path (Join-Path $sbHome 'cloud.json')) "no cloud.json in $sbHome (in the project folder: $(Test-Path (Join-Path $project '.scopebond\cloud.json')))"
    Assert (-not (Test-Path (Join-Path $project '.scopebond'))) 'login wrote a .scopebond folder into the project it was run from'
  }
  $settingsFile = Join-Path $env:USERPROFILE '.claude\settings.json'
  Check 'the hook is in the user-level Claude Code settings' {
    Assert (Test-Path $settingsFile) "no $settingsFile"
    $script:hookCommand = ((Get-Content $settingsFile -Raw | ConvertFrom-Json).hooks.PreToolUse | Select-Object -First 1).hooks[0].command
    Assert ($script:hookCommand -match 'claude\s*$') "unexpected hook command: $($script:hookCommand)"
  }

  # 3. One action, as Claude Code would send it; one record delivered.
  Check 'a push to main is denied by the configured hook command, and one record reaches the workspace' {
    $payload = '{"tool_name":"Bash","tool_input":{"command":"git push origin main"},"cwd":"' + ($project -replace '\\', '\\') + '"}'
    $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $out = $payload | & cmd.exe /d /s /c $script:hookCommand 2>&1; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $previous }
    Assert ($code -eq 2) "expected a block (exit 2), got $code`: $out"
    $flush = Invoke-Published 'npx.cmd' @('-y', $HookPackage, 'flush')
    Assert ($flush.Code -eq 0) "flush exited $($flush.Code): $($flush.Out)"
    $state = Get-CloudState
    Assert ($state.ingested -eq 1) "expected one delivered record, the workspace has $($state.ingested)"
    Assert ($state.ingested_results[0] -eq 'deny') "the delivered record says $($state.ingested_results[0])"
  }
  Check 'npx.cmd ... doctor is green' {
    $doctor = Invoke-Published 'npx.cmd' @('-y', $HookPackage, 'doctor')
    Assert ($doctor.Code -eq 0) "doctor exited $($doctor.Code):`n$($doctor.Out)"
  }

  if (-not $SkipAgent) {
    if (-not $AgentPackage) { throw '-AgentPackage is required unless -SkipAgent is given' }
    # 4. The agent, installed and started the published way.
    Check 'npm.cmd install -g the agent puts scopebond-agent.cmd on PATH' {
      $install = Invoke-Published 'npm.cmd' @('install', '-g', $AgentPackage)
      Assert ($install.Code -eq 0) "npm.cmd install -g exited $($install.Code):`n$($install.Out)"
      $prefix = ((& npm.cmd prefix -g) 2>$null | Select-Object -First 1).Trim()
      Assert (Test-Path (Join-Path $prefix 'scopebond-agent.cmd')) "npm installed no scopebond-agent.cmd in its global folder $prefix"
      if (-not (Get-Command 'scopebond-agent.cmd' -ErrorAction SilentlyContinue)) {
        # Found on real computers too (nvm-windows, a custom prefix): npm's global folder is not on
        # PATH, so the next published command is "not recognized". Continue as a person who added it.
        Write-Host "       note: npm's global folder $prefix is not on PATH; scopebond-agent.cmd would be 'not recognized' (W16)"
        $env:PATH = "$prefix;$env:PATH"
      }
      Assert ($null -ne (Get-Command 'scopebond-agent.cmd' -ErrorAction SilentlyContinue)) 'scopebond-agent.cmd is not runnable'
    }
    Check 'scopebond-agent.cmd autostart on: Run key, launcher, and the agent running' {
      $on = Invoke-Published 'scopebond-agent.cmd' @('autostart', 'on')
      Assert ($on.Code -eq 0) "autostart on exited $($on.Code): $($on.Out)"
      $launcher = Join-Path $sbHome 'agent-launch.cmd'
      $run = Get-RunValue
      Assert ($null -ne $run) 'no ScopebondAgent value under HKCU\...\Run'
      Assert ($run -like "*$launcher*") "the Run value does not start the launcher: $run"
      Assert (Test-Path $launcher) "no launcher at $launcher"
      $running = $false
      for ($i = 0; $i -lt 30 -and -not $running; $i++) {
        $status = Invoke-Published 'scopebond-agent.cmd' @('status', '--json')
        try { $running = $null -ne ($status.Out | ConvertFrom-Json).agent } catch { $running = $false }
        if (-not $running) { Start-Sleep -Seconds 1 }
      }
      Assert $running "the agent is not running after autostart on:`n$($on.Out)"
    }
    Check 'scopebond-agent.cmd check: the self-check passes and the workspace receives it' {
      $check = Invoke-Published 'scopebond-agent.cmd' @('check')
      Assert ($check.Code -eq 0) "check exited $($check.Code): $($check.Out)"
      $state = Get-CloudState
      Assert (@($state.self_checks).Count -ge 1) 'the workspace received no self-check'
      $last = @($state.self_checks)[-1]
      Assert (@($last.failed).Count -eq 0) "the self-check failed: $(@($last.failed) -join ', ')"
    }
    Check 'scopebond-agent.cmd status says running, connected and self-check passed' {
      $status = Invoke-Published 'scopebond-agent.cmd' @('status')
      Assert ($status.Code -eq 0) "status exited $($status.Code)"
      Assert ($status.Out -match 'Scopebond Agent: running') $status.Out
      Assert ($status.Out -match 'connected\s+yes') $status.Out
      Assert ($status.Out -match 'self-check\s+passed') $status.Out
    }

    # 5. Off and out: nothing left behind.
    $agentPid = $null
    try { $agentPid = (Get-Content (Join-Path $sbHome 'agent.json') -Raw | ConvertFrom-Json).pid } catch { }
    Check 'scopebond-agent.cmd autostart off removes the Run key and the launcher' {
      $off = Invoke-Published 'scopebond-agent.cmd' @('autostart', 'off')
      Assert ($off.Code -eq 0) "autostart off exited $($off.Code): $($off.Out)"
      Assert ($null -eq (Get-RunValue)) 'the ScopebondAgent Run value is still there'
      Assert (-not (Test-Path (Join-Path $sbHome 'agent-launch.cmd'))) 'the launcher is still there'
    }
    Check 'npm.cmd uninstall -g the agent leaves no command and no running agent' {
      $un = Invoke-Published 'npm.cmd' @('uninstall', '-g', '@scopebond/agent')
      Assert ($un.Code -eq 0) "npm.cmd uninstall -g exited $($un.Code): $($un.Out)"
      Assert ($null -eq (Get-Command 'scopebond-agent.cmd' -ErrorAction SilentlyContinue)) 'scopebond-agent.cmd is still on PATH'
      Start-Sleep -Seconds 2
      $alive = $agentPid -and (Get-Process -Id $agentPid -ErrorAction SilentlyContinue)
      if ($alive) { Stop-Process -Id $agentPid -Force -ErrorAction SilentlyContinue }
      Assert (-not $alive) "the agent (pid $agentPid) is still running after autostart off and uninstall"
    }
  }

  # Everything Scopebond printed for the person to run is in the form PowerShell accepts.
  Check 'every command Scopebond printed uses the .cmd form' {
    $plain = @()
    foreach ($text in $script:Printed) { $plain += Find-PlainCommands $text }
    $plain = $plain | Sort-Object -Unique
    Assert (@($plain).Count -eq 0) ("printed without .cmd (PowerShell blocks these):`n" + ($plain -join "`n"))
  }
} finally {
  Set-Location $env:TEMP
  if ($fake -and -not $fake.HasExited) { Stop-Process -Id $fake.Id -Force -ErrorAction SilentlyContinue }
}

if ($script:Failures.Count) {
  Write-Host "`n$($script:Failures.Count) check(s) failed"
  exit 1
}
Write-Host "`nall checks passed"
exit 0
