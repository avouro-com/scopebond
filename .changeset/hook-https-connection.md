---
"@scopebond/hook": patch
---

A stored Cloud connection is used only when its workspace address is HTTPS (or localhost), the same rule `login` applies, so the machine credential is never sent in clear even if `cloud.json` was edited by hand.
