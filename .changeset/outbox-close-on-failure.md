---
"@scopebond/gateway": patch
---

A Cloud delivery queue that cannot be set up (a full disk, a read-only file) closes its database handle before it reports the error. Before, the handle stayed open, and on Linux the next open of the same file in that process reused it and stayed read-only after the problem was fixed.
