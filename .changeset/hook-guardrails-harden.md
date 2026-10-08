---
"@scopebond/hook": patch
---

The always-on protection of Scopebond's own folder and the coding agents' hook settings holds in more cases. The signed
executable's own commands (`scopebond-agent.exe hook uninstall`, `rules` changes, `login`/`connect`, `uninstall`, `setup`),
removing the signed or npm install through Windows (msiexec, winget, the Settings → Apps uninstall script, the Run value),
and stopping the tray by name are treated as switching Scopebond off. NTFS stream and index suffixes in a path are read as
the plain path. PowerShell's .NET file calls (`[IO.File]::…`, `New-Object IO.StreamWriter`), `Tee-Object -FilePath` and
`Expand-Archive -DestinationPath` are read as file reads and writes. Claude Code's Grep tool is a read of what it searches.
Deleting Scopebond's files or the agents' hook settings (`rm`, `Remove-Item`, `find -delete`) is a protected write.
