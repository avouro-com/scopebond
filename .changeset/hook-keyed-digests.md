---
"@scopebond/hook": minor
---

Command and MCP-argument digests in receipts are now keyed (HMAC-SHA-256 under a per-machine `.scopebond/digest.key`, created by `init` or on first use) and labelled `hmac-sha256:`. A plain SHA-256 of a command whose scrubbed head is printed beside it left only the unseen remainder to guess, so a short secret the scrubber missed could be recovered offline from a receipt; MCP arguments were digested unscrubbed. Digests still match for identical actions on the same machine. The starter policy already denies agent reads of `.scopebond/` and `*.key`.
