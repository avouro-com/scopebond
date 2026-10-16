---
"@scopebond/github-action": patch
---

The action now runs a bundled check: one file that holds every dependency, fetched as the package's own tarball with no dependency resolved or installed at run time, so pinning the action to a commit pins all of the checking code. The README examples now pin a commit instead of following `@main`.
