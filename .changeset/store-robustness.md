---
"@scopebond/gateway": patch
---

Local stores tolerate concurrent writers and crashes. SQLite stores (receipts and the Cloud outbox) open with WAL and a 5-second busy timeout, so parallel hook processes wait for the lock instead of failing with SQLITE_BUSY. `openReceiptStore` falls back to a JSONL file only when `node:sqlite` is unavailable, and then beside the requested database rather than in the current directory; a database that exists but cannot be opened is now an error instead of a silent switch to another log. The JSONL store truncates a torn final line left by a crash and refuses a corrupt record anywhere else.
