# Scans release files with Microsoft Defender Antivirus, on current definitions, before they are published.
#
#   pwsh -File packages/native/defender-scan.ps1 <file> [<file> ...]
#
# Exits 0 when Defender finds nothing in any file, 1 when it detects something (the file and the detection are listed in
# the job summary) or when Defender cannot scan here (no antivirus, no definitions): a release is published only after a
# scan that ran. A signed build with a clean scan needs no manual submission to Microsoft; reputation follows the signing
# identity. Files are scanned in place and never removed (-DisableRemediation).
param([Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)][string[]]$Files)
$ErrorActionPreference = 'Stop'

function Write-Summary([string]$Text) {
  if ($env:GITHUB_STEP_SUMMARY) { Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value $Text -Encoding utf8 }
  Write-Host $Text
}

$status = $null
try { $status = Get-MpComputerStatus } catch { $status = $null }
if (-not $status -or -not $status.AntivirusEnabled) {
  Write-Summary "Microsoft Defender Antivirus is not available on this runner, so nothing was scanned."
  exit 1
}

# Current definitions first; a scan on stale definitions says little about what a customer's computer will see.
try { Update-MpSignature -UpdateSource MicrosoftUpdateServer } catch { Write-Host "Definition update from Microsoft Update failed: $($_.Exception.Message)" }
$status = Get-MpComputerStatus
$age = (New-TimeSpan -Start $status.AntivirusSignatureLastUpdated -End (Get-Date)).TotalHours
if ($age -gt 48) {
  Write-Summary "Defender's definitions are $([math]::Round($age)) hours old ($($status.AntivirusSignatureVersion)); not scanning on stale definitions."
  exit 1
}

$cmd = Join-Path $env:ProgramFiles 'Windows Defender\MpCmdRun.exe'
$platform = Get-ChildItem -Path (Join-Path $env:ProgramData 'Microsoft\Windows Defender\Platform') -Directory -ErrorAction SilentlyContinue |
  Sort-Object Name -Descending | Select-Object -First 1
if ($platform -and (Test-Path (Join-Path $platform.FullName 'MpCmdRun.exe'))) { $cmd = Join-Path $platform.FullName 'MpCmdRun.exe' }
if (-not (Test-Path $cmd)) { Write-Summary "MpCmdRun.exe was not found, so nothing was scanned."; exit 1 }

$rows = @()
$found = $false
foreach ($file in $Files) {
  $path = (Resolve-Path $file).Path
  $output = & $cmd -Scan -ScanType 3 -File $path -DisableRemediation 2>&1 | Out-String
  $code = $LASTEXITCODE
  $name = Split-Path $path -Leaf
  if ($code -eq 0) {
    $rows += "| $name | clean |"
  } elseif ($code -eq 2) {
    $found = $true
    $threats = ($output -split "`r?`n" | Where-Object { $_ -match 'Threat\s*:' }) -join '; '
    if (-not $threats) { $threats = 'detected (see the log)' }
    $rows += "| $name | **$threats** |"
    Write-Host $output
  } else {
    $found = $true
    $rows += "| $name | scan failed (MpCmdRun exit $code) |"
    Write-Host $output
  }
}

Write-Summary "### Microsoft Defender scan"
Write-Summary "Definitions $($status.AntivirusSignatureVersion), engine $($status.AMEngineVersion)."
Write-Summary ""
Write-Summary "| File | Result |"
Write-Summary "|---|---|"
foreach ($row in $rows) { Write-Summary $row }
if ($found) {
  Write-Summary ""
  Write-Summary "Defender flagged a file or could not scan it. Submit the flagged file at https://www.microsoft.com/en-us/wdsi/filesubmission as a software developer (Incorrectly detected), then run the release again."
  exit 1
}
exit 0
