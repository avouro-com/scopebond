---
"@scopebond/sdk": patch
---

When the gateway answers without JSON, the error `submit()` throws now carries the parse error as its `cause`.
