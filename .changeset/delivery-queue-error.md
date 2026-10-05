---
"@scopebond/hook": patch
---

When the delivery queue cannot be opened or written (a full disk, a read-only or locked file), the hook still fails closed, but its message names the queue file and the fix: free disk space or make the file and its `-wal` and `-shm` files writable (SQLite creates them with the database's permissions, so a read-only episode can leave them read-only too), and do not delete it, because it holds records waiting to be sent. It used to say to run `init`, which does not help. `status` and `doctor` say the queue is unusable (and that every action is blocked) instead of "0 waiting", and `status --json` reports it as `delivery.queue_error` with the error code `queue_unusable`.
