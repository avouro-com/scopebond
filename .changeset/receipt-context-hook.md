---
"@scopebond/hook": minor
---

Records now carry an optional `context` saying where they were produced: the coding agent (`claude`, `cursor` or
`codex`), its version when it reports one (Cursor), the model when the hook input names it, the same keyed session id
the observations carry (never the agent's own session id), the git remote `origin` as `host/owner/name` (no credentials,
no `.git`, never a local path) and the branch. `log` shows it after each action, and `verify` checks it with the rest of
the receipt.

A computer that is not connected always records it. A connected computer adds it only once its workspace says it reads
it: the rules check or a delivery answer carries the header `x-scopebond-receipt-context: 1`, kept as `receipt_context`
in the rules state. A full rules check answer without the header turns it off again, so a workspace that does not read
the context is never sent it.
