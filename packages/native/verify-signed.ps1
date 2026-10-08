<#
.SYNOPSIS
  Every .exe and .msi in a folder is signed by Avouro LLC, validly and with a timestamp.

.DESCRIPTION
  For each file: Windows' own verdict on its Authenticode signature is Valid, it carries a timestamp, and its signer is
  Avouro LLC by the same anchored rule the agent's updater uses before it installs anything (PUBLISHER in
  packages/agent/src/native-update.ts): the subject's O= field is exactly "Avouro LLC", matched case-sensitively, so
  "O=Avouro LLC Ltd" or a CN that merely contains the words does not pass. With -SignTool, signtool verify /pa as well.

.PARAMETER Folder
  The folder to check (with its subfolders).
.PARAMETER SignTool
  Also run signtool verify /pa (from the Windows SDK) on each file.
#>
param(
  [Parameter(Mandatory = $true)][string] $Folder,
  [switch] $SignTool
)
$ErrorActionPreference = 'Stop'

# The updater's rule (native-update.ts PUBLISHER); a test keeps the two the same.
$Publisher = '(^|,\s*)O=Avouro LLC(,|$)'

$files = @(Get-ChildItem -LiteralPath $Folder -Recurse -File | Where-Object { $_.Extension -in @('.exe', '.msi') })
if ($files.Count -eq 0) { throw "no .exe or .msi in $Folder" }

$tool = $null
if ($SignTool) {
  $kits = 'C:\Program Files (x86)\Windows Kits\10\bin'
  $tool = Get-ChildItem $kits -Recurse -Filter signtool.exe | Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName -Descending | Select-Object -First 1
  if (-not $tool) { throw 'signtool.exe not found' }
}

foreach ($file in $files) {
  if ($tool) {
    & $tool.FullName verify /pa /v $file.FullName
    if ($LASTEXITCODE -ne 0) { throw "signature check failed: $($file.Name)" }
  }
  $sig = Get-AuthenticodeSignature -LiteralPath $file.FullName
  if ("$($sig.Status)" -ne 'Valid') { throw "$($file.Name): $($sig.Status)" }
  $subject = "$($sig.SignerCertificate.Subject)"
  if ($subject -cnotmatch $Publisher) { throw "$($file.Name): unexpected publisher $subject" }
  if (-not $sig.TimeStamperCertificate) { throw "$($file.Name): not timestamped" }
  "$($file.Name): signed by $subject, timestamped by $($sig.TimeStamperCertificate.Subject)"
}
