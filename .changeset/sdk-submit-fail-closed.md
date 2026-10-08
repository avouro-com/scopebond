---
"@scopebond/sdk": patch
---

`submit()` now fails closed: it rejects on a non-2xx answer that is not an explicit deny, on an answer without a boolean `allowed`, and after a timeout (default 10 s, set with the new `{ timeoutMs }` option).
