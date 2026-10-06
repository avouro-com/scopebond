---
"@scopebond/gateway": minor
---

Cloud delivery compresses a batch with gzip once the workspace has said it reads gzip (`Accept-Encoding: gzip` on an ingest answer) and the batch is at least 1 KiB (`gzipMinBytes`; 0 turns it off). A workspace that never says so keeps receiving plain JSON, so older workspaces are unaffected.
