---
"@scopebond/hook": minor
"@scopebond/gateway": minor
---

Reconnecting a computer always works now. When the workspace refuses this computer's countersigning key because the computer was replaced or disconnected there, `login` and `connect` replace the key and enroll again with the same, unspent token. The old key is kept in `retired-keys/`. Queued receipts signed by the earlier key leave the delivery queue as `rekeyed` gaps, so they no longer hold up newer receipts, and they stay in the local log.

New `recover` command: it finds the local records an earlier key signed, asks the workspace to accept them, waits while an owner or admin approves it there, then sends them in bounded batches and reports how many were recovered, already present or refused. Nothing is re-signed.

`login` and `connect` run from a folder without its own project setup now repair the connection the hook actually uses, usually the user-level one, instead of creating a second, project-level setup beside it. `--project` sets up the current folder explicitly.

Gateway changes: enrollment refusals are a `CloudEnrollmentError` that carries the HTTP status and the workspace's code. `SqliteReceiptStore.page()` walks a large log without loading it into memory. `SqliteCloudOutbox.discardNotSignedBy()` sets aside queued receipts signed by another key.
