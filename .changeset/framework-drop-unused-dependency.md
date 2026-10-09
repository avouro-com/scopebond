---
"@scopebond/framework": patch
---

Drop the unused direct dependency on `@scopebond/policy-schema`. The framework never imports it; it still arrives through `@scopebond/gateway`.
