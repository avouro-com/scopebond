---
"@scopebond/hook": patch
"@scopebond/verify": patch
"@scopebond/policy-schema": patch
---

A workspace can now switch a rule Off (the hook reports the `rule_off` capability): the rule's actions run as routine and match nothing, while Scopebond's own protection and the refusal of commands whose program is only known when they run stay on, and an Off on a rule that can never be off is enforced as Block and noted in `status`.

A workspace can now name exceptions for every rule that takes them, in Monitor as in Block (the hook reports the `exceptions_any_rule` capability): programs and the folders outside the working folder they may delete in for destructive-shell, environment names for production deploys, Kubernetes contexts and Terraform workspaces for cloud deletes, local database addresses for migrations, and sites for network requests; an excepted action matches no rule, and an exception never reaches further than what it names.

An `action_allowlist` clause may carry `exceptions`, sets of bounds that excuse an action from the clause's `param_bounds` when it meets every bound of one set; a delete that reaches outside the working folder records those targets as `delete_targets`.

A bare `git push` or `git push --force-with-lease` whose current branch cannot be read is now judged by the branch git names as its upstream, and is still denied when git cannot tell.
