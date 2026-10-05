---
"@scopebond/hook": patch
---

When the delivery queue cannot be opened or written (a full disk, a read-only or locked file), the hook still fails closed, but its message names the queue file and the fix: free disk space or make the file writable, and do not delete it, because it holds records waiting to be sent. It used to say to run `init`, which does not help.
