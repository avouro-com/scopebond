---
"@scopebond/gateway": patch
"@scopebond/hook": patch
---

A refused batch that no retry can deliver no longer holds up the records behind it. When the workspace refuses every record of a batch on its own as `invalid_receipt` (HTTP 400 with `rejected`), each becomes a "rejected" delivery gap, as inside an accepted batch. Any other code is retried: a timestamp ahead of the workspace's clock is accepted once the time passes, and a key the connection did not enroll is delivered after signing in again. A 409 `id_conflict` sends records one at a time until it finds the record that conflicts, which becomes an "id_conflict" gap; the rest go in batches again. Before, the exporter sent the same batch forever and every newer record waited. Every other refusal is retried with backoff, as before. A workspace that answers 429 or 503 with `Retry-After` is not asked again sooner (at most an hour).
