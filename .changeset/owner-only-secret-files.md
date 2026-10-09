---
"@scopebond/gateway": patch
"@scopebond/hook": patch
"@scopebond/agent": patch
"@scopebond/mcp": patch
---

Keys, the Cloud credential, chain heads and the receipt and dispatch databases (with the journal files SQLite keeps beside them) are readable by their owner alone from their first byte, on Windows and POSIX, also in a folder other local users can open; a credential write replaces a file or link at its name instead of writing through it, and processes that create a key at the same moment now agree on one key.

Upgrading: the hook's and the agent's folder is made readable by its owner alone on their next run, files an older version left there included. A self-hosted gateway or MCP proxy restricts its existing key files, credential file and databases the next time it opens them.
