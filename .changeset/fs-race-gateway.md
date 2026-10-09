---
"@scopebond/gateway": patch
---

The attester key and the dispatch binding key are now created exclusively with owner-only permissions (a damaged binding key is replaced atomically), `init` claims its files with an exclusive create, and dispatch and approval files are size-checked on the same open file they are read from.
