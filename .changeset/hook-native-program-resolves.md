---
"@scopebond/hook": patch
---

`doctor` no longer reports the signed single executable on macOS and Linux (`"/…/scopebond-agent" hook claude`) as a hook command that cannot start: a program with no `.js` or `.exe` extension now counts as startable while it exists.
