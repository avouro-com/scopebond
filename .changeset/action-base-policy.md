---
"@scopebond/github-action": minor
---

Security: evaluate the policy from the pull request's base commit, not the branch under review, so a pull request cannot loosen the policy it is checked against. The changed-file list now comes from the pull request API (including renamed files' old names) with a merge-base fallback, and the check fails closed when neither yields paths or when fewer paths than the PR's `changed_files` were resolved (the files API stops at 3000 files). The README example now runs on `pull_request_target` with a base-only checkout, so a pull request cannot edit the workflow that checks it. `--policy-source workspace` remains for local testing.
