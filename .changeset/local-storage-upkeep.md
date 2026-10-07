---
"@scopebond/gateway": minor
"@scopebond/hook": minor
"@scopebond/agent": minor
---

A small, steady local store. A hook call's memory and time no longer grow with the local history: the replay check is one
indexed lookup instead of reading every receipt (a call on a 767 MB log peaked at 69 MB, down from 233 MB, and 504 MB for a
three-part shell command; it took 0.26 s instead of 1–1.8 s). The SQLite store keeps each policy once and each receipt once,
and keeps nothing for an action that finished without being dispatched; a log from an earlier version is rewritten to this
layout and shrinks (767 MB became 93 MB with every receipt kept).

Receipts a workspace acknowledged are removed 30 days after it did (the workspace can set 7–365 days); a receipt it has not
acknowledged is never removed, an anchored log is never pruned, and a computer with no workspace keeps everything. The
Scopebond Agent runs this upkeep; a hook-only install runs a short pass once a day and leaves rewriting an older file to a
background process. `prune` reports the retention, and `prune --compact` runs the upkeep now.

Also: `sed -n a,bp f` reads `f`, not a file named after the script; `cat $f` no longer records a read of a file called `$f`;
Scopebond's own folder named in an interpreter's arguments (`node -e`, `python script.py ~/.scopebond/…`, `sqlite3`) is
treated as a read of it; `rules.json` and `cloud.json` are read once per call; the delivery queue keeps its totals.
`@scopebond/gateway` adds `ReceiptStore.authorizationUsed`, `SqliteReceiptStore.maintain`, `SqliteCloudOutbox.markAcknowledged`
and `pendingCount`, and re-exports `historyNeed`.
