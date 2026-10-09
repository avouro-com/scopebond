---
"@scopebond/agent": patch
"@scopebond/gateway": patch
---

The agent keeps answering while it works. The local store's upkeep (up to 30 seconds of database work, or a full rewrite
of an older file) now runs as `scopebond-agent upkeep` in a process of its own, so the tray, `status` and the workspace's
requests are answered meanwhile. One cycle sends for at most a minute and the next cycle starts at once while records
remain, so a long queue never holds up the rules check. The gateway's exporter lets the event loop run between batches
and takes `flush({ maxMs })`: no new batch starts once that time is up.
