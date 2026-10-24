---
"@scopebond/hook": patch
---

Trailing slashes are trimmed from the workspace address (rules check, Safe Install verdicts) and from working folders in one linear pass, so an address with a long run of slashes can no longer make the hook spend time that grows with the square of its length.
