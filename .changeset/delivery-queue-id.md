---
"@scopebond/gateway": minor
"@scopebond/hook": minor
---

Each delivery queue has its own id, made once when the queue is created, and the exporter sends it beside the record numbers. The hook's rules check reports the queue id and the highest number the queue has given a record (`x-scopebond-queue-id`, `x-scopebond-seq-assigned`), so a workspace can tell numbering that restarted because the queue was removed from a resend, and count the records that queue never delivered.
