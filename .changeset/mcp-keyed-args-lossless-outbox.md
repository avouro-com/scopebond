---
"@scopebond/mcp": patch
---

`args_digest` on the proxy's receipts is now an HMAC-SHA-256 (`hmac-sha256:…`) of the tool arguments under a local key instead of a plain SHA-256, so a short argument cannot be confirmed offline from a receipt. The CLI keys it with the hook's per-machine digest key when `--observations-dir` names the hook's folder, else with the key file beside the signing key (`<key>.binding`, made on first use); the library takes `argsDigestKey` (64 hex) and exports `keyedArgsDigest`. The Cloud outbox is now lossless (no cap, no expiry, like the hook's and the agent's), and `openExporter` reports delivery gaps to an `onGap` option (stderr by default). Upgrade note: `args_digest` values change format, so they no longer match digests recorded by earlier versions.
