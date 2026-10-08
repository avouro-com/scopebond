---
"@scopebond/hook": patch
---

The digest key and the observation binding key are now created exclusively with owner-only permissions, and a damaged one is replaced atomically, so a file or link placed at the path beforehand never receives the key; config and export files are read without a separate existence check.
