---
"@scopebond/hook": patch
---

`scopebond login` now names the workspace that approved its code, where that workspace keeps its data, and who approved it, then asks before connecting. Pass `--yes` to connect without asking, for example from a script. A rate-limited or busy workspace (429 or 503) no longer ends the login: it waits as the workspace asks and keeps polling until the code expires.
