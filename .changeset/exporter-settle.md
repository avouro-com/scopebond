---
"@scopebond/gateway": patch
"@scopebond/hook": patch
---

A refused batch that no retry can deliver no longer holds up the records behind it. When the workspace refuses every record of a batch on its own (HTTP 400 with `rejected`), each becomes a "rejected" delivery gap, as inside an accepted batch, unless one was refused for a timestamp ahead of the workspace's clock, which is retried because it is accepted once the time passes. A 409 `id_conflict` sends the rest of the queue one record at a time to find the record that conflicts, which becomes an "id_conflict" gap. Before, the exporter sent the same batch forever and every newer record waited. Every other refusal is retried with backoff, as before. A workspace that answers 429 or 503 with `Retry-After` is not asked again sooner (at most an hour).
