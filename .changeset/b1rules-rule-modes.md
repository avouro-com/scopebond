---
"@scopebond/hook": patch
---

A workspace can now switch a rule Off (the hook reports the `rule_off` capability): the rule's actions run as routine and match nothing, while Scopebond's own protection and the refusal of commands whose program is only known when they run stay on, and an Off on a rule that can never be off is enforced as Block and noted in `status`.
