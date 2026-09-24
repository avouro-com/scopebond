---
"@scopebond/verify": minor
"@scopebond/hook": minor
---

Security: `force_push_guard` now covers branch deletion and all-branch pushes, and its default protects nested release branches.

The clause previously fired only on a `--force` push whose single resolved ref matched the protected set. Three destructive pushes slipped through:

- **Deletion** (`git push origin :main`, `git push origin --delete main`) removes a protected branch and is destructive even without `--force`; it was treated as an ordinary push.
- **All-branch force pushes** (`git push --all --force`, `git push --mirror`) reach every branch — so they necessarily rewrite the protected ones, and `--mirror` also prunes — but their whole-repo push carried no single protected ref to match.
- The default protected set was `["main", "master", "release/*"]`; the single-star glob does not cross `/`, so `release/1.0/hotfix` was unprotected. The default is now `release/**`.

The hook mapper marks these on the `git.push` intent it emits (`delete` for `:dst`/`--delete`, `all` for `--all`/`--mirror`/`--branches`), and `force_push_guard` denies a delete of a protected ref (regardless of `force`), a force-push to all branches, and a force-push to a protected ref, still allowing ordinary pushes, feature-branch force-pushes and a non-forced `--all`. A destructive push whose target ref cannot be resolved still fails closed. The hook's own starter policy already denied these through its stricter ref allowlist; this closes the gap for customer policies that use the `force_push_guard` clause.
