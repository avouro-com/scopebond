---
"@scopebond/hook": minor
"@scopebond/gateway": minor
---

`status --json` prints the delivery and identity status in one machine-readable shape (`scopebond.status.v1`): `state` (`delivering`, `recording_locally` or `not_governing`), the last delivery and its error code, records waiting and the age of the oldest, delivery gaps by reason, this computer's installation, generation, key and credential expiry, and which configurations exist. The desktop agent and support read this, not the human text.

A record the workspace refuses on its own (the rest of the batch stored) now leaves the delivery queue as a `rejected` gap instead of being retried with every batch, so one bad record can never hold up the ones behind it; it stays in the local log. The SQLite outbox gains `recordGap` and `gapsByReason`.

A delivery conformance suite runs the real runtime and queue against a workspace that refuses the connection, fails with 5xx, stays unreachable for eight days, and refuses single records: in every case each record is delivered or accounted for.
