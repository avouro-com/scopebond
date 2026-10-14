---
"@scopebond/hook": patch
"@scopebond/gateway": patch
---

`scopebond flush` no longer fails when the only records left are routine ones waiting for their summary window. With summary records on (the default evidence detail), routine allows wait for their five-minute window to close and then leave as one signed summary; `flush` used to count them as "still pending" and exit 1. It now reports them on their own line ("N routine record(s) held for the summary window until HH:MM", in local time) and exits 0 when nothing else is waiting. It still exits 1 when a notable record (a block, a warning, an override and the like) is left undelivered or the last delivery attempt failed. The cloud exporter gains an optional `held()` method that counts the routine records held for an open window and says when the last of those windows closes.
