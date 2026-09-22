---
"@scopebond/policy-schema": minor
"@scopebond/verify": minor
---

Add a `force_push_guard` clause type. It denies a `git.push` that is a force-push to a protected branch (matched against `protected_refs`; glob, default `["main", "master", "release/*"]`), while still allowing ordinary pushes to those branches and force-pushes to feature branches. A force-push whose target ref cannot be resolved is denied (fail closed). This expresses a predicate a per-field `action_allowlist` bound cannot, since it must AND the `force` flag with a protected-ref set.
