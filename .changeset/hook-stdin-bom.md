---
"@scopebond/hook": patch
---

The hook reads an event that starts with a UTF-8 byte-order mark. Windows PowerShell 5.1 and other .NET Framework programs write one before text they pipe in; the hook used to refuse the whole event as invalid JSON (failing closed, so every action was blocked).
