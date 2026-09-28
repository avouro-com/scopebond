---
"@scopebond/hook": patch
---

`connect` and `login` now trust the project policy they set up when a user-level install exists, as `init` does. Before this, the hook ignored the untrusted project and used the user-level policy, which has no workspace connection, so a connected project's actions never reached the workspace even though the command reported success. Setup commands (`init`, `install`, `connect`, `login`) also stop early with a plain message on Node older than 22.13, instead of failing later on a missing module.
