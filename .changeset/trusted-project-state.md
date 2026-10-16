---
"@scopebond/hook": patch
---

A trusted project can no longer let through what its policy blocks with files placed beside that policy.

- In a project whose own policy governs because you trusted it (a user-level install exists), what can let a blocked action through (the workspace rules document's allow and ask terms, allowances, and the record of earlier overrides) is read from and written to the user-level folder, never the project's `.scopebond` folder. A repository could otherwise add a `managed-rules.json` and an `allowances.json` beside its unchanged, trusted `policy.json` and turn a block into an allowance.
- The trust pin now covers the project's `rules.json` (read on each call for the allowed roots and the remote-database guard) and the workspace its `cloud.json` names (not the credential, which renews), as well as `policy.json`. A change to any of them stops the project's policy applying until you run `scopebond trust` again. A pin made by an earlier version is honoured while `policy.json` is unchanged, and renewed to cover the other two.
- New export: `decisionStateDir`.
