---
"@scopebond/hook": patch
"@scopebond/policy-schema": patch
---

A delete outside the working folder whose every target is tracked and committed in a git repository (nothing modified, staged, untracked or ignored under it) is now recorded instead of blocked, as `program_scope` `<program>/git_restorable`, because git can restore it; an untracked or changed target, a target outside any repository, the repository's own top folder, and any git error or slow answer keep the block.

A person who may unblock an action can now allow "Similar commands in this project" instead, where the workspace lets them (`override.patterns`: `person`, `needs_admin` or `off`; the hook reports the `pattern_allowances` capability): the allowance carries `match` (the rule, the action type, the recipe and its bounds) and never matches outside one folder of one project or repository, another rule, or an always-on protection.

The policy schema now defines a rule's pattern recipes (`allow_patterns`: `path_prefix`, `path_glob`, `package_name`, `host`, `mcp_tool`) and the bounds of a pattern allowance (`allowance.match`), with checks that refuse any bound wider than one project folder or repository, a `..` or `.` segment, or a wildcard where a folder is named.
