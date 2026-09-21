---
"@scopebond/hook": patch
---

Starter policy: block writes to CI config and reads of environment secret files (SB81).

`npx @scopebond/hook init` now scaffolds a starter policy whose `protect-write` clause
also denies writes to CI configuration (`.github/workflows/`, `.github/actions/`,
`.gitlab-ci.yml`, `.circleci/`, `azure-pipelines.yml`, `Jenkinsfile`) and whose
`protect-read` clause also denies reads of environment secret files (`.env`, `.env.*`),
while still allowing `.env.example`/`.sample`/`.template`. This closes the gap between
the documented protection ("a write to your CI config — blocked before it runs") and the
shipped default. Existing scaffolded policies are unchanged — the policy is a plain JSON
file the operator edits; only newly-initialized policies pick up the tighter defaults.
