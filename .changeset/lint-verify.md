---
"@scopebond/verify": patch
---

`violates()` no longer throws on an action param object that carries its own `toString` key or on a policy whose array-bound `items` pattern is not a valid regular expression (that policy is now rejected as invalid), and the evaluator's clause and bound types are explicit instead of `any`.
