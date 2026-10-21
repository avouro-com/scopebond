---
"@scopebond/hook": patch
---

A delete outside the working folder whose every target is tracked and committed in a git repository (nothing modified, staged, untracked or ignored under it) is now recorded instead of blocked, as `program_scope` `<program>/git_restorable`, because git can restore it; an untracked or changed target, a target outside any repository, the repository's own top folder, and any git error or slow answer keep the block.
