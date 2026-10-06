---
"@scopebond/gateway": patch
"@scopebond/hook": patch
---

Several checks opening the local log at the same moment no longer fail closed with "database is locked" on Windows. Switching a log to WAL takes a lock that SQLite's busy timeout does not always wait for, so that one step now retries for up to 15 seconds. The hook also no longer counts its own signing key (`agent.key`) as a sign that the Scopebond Agent is installed, so `doctor` passes on a computer without the agent.
