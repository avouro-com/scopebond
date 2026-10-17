---
"@scopebond/agent": minor
---

Install keys for company-wide installs. A Windows install given an install key (`msiexec ... ALLUSERS=1 KEY=sbk_...`, kept as the `InstallKey` setting) connects to its workspace on its first start with no sign-in code, as an unclaimed computer that its person then claims from the tray. A key that is not accepted falls back to the usual sign-in with a code. The installer keeps the key out of its log.
