---
"@scopebond/github-action": minor
---

Security: evaluate the policy from the pull request's base commit, not the branch under review, so a pull request cannot loosen the policy it is checked against. The changed-file list now comes from the pull request API (including renamed files' old names) with a merge-base fallback, and the check fails closed when neither yields paths. `--policy-source workspace` remains for local testing.
