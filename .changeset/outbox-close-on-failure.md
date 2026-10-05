---
"@scopebond/gateway": patch
---

A Cloud delivery queue that cannot be set up (a full disk, a read-only file) closes its database handle before it reports the error, instead of leaving it open.
