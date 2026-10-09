---
"@scopebond/mcp": patch
---

The proxy's local binding key is now created exclusively with owner-only permissions (a damaged one is replaced atomically), and `init` writes the starter policy through an exclusive create when it is absent.
