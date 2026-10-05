---
"@scopebond/gateway": minor
"@scopebond/hook": patch
---

Sequenced delivery: the Cloud outbox gives each queued record this computer's number for it (1, 2, 3… in queue order, kept across restarts and never reused), and the exporter sends the numbers beside the receipts (`{ receipts, seq }`; the signed receipts are unchanged). A workspace that reads them can show records lost on the computer, for example aged out of the queue, as missing instead of silently absent. Queues made before this are upgraded in place; their waiting records stay unnumbered.
