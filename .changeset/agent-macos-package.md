---
"@scopebond/agent": patch
---

On macOS, the executable the installer package puts in `/usr/local/bin` counts as installed for every user: it never tries to update itself with the Windows installer, and `uninstall` names the package's removal script (`sudo "/Library/Application Support/Scopebond/uninstall.sh" --purge`) instead of `msiexec`. The executable run from anywhere else on a Mac names no installer.
