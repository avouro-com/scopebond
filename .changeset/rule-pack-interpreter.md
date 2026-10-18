---
"@scopebond/hook": minor
---

Run signed rule packs. The hook reads the packs cached in its state directory (`packs/index.json` and `packs/<id>@<version>.json`), uses one only when its signature verifies with a trusted policy-signing key and the last check-in was no more than 30 days ago, and turns commands and MCP calls into taxonomy actions through the pack's grammars and profiles. The built-in readers still win where they derive anything; a missing, bad or expired pack only stops adding actions, so the open detection and the starter protections always apply. New `packs` command: `list`, `verify <file>`, `add <file>` and `remove <id>`. Every pack's vectors run through `runPackVectors`.
