---
"@scopebond/hook": patch
---

Each rule pack now keeps its own 30-day clock: when the workspace names a pack version this computer cannot fetch or check, that pack keeps its last good version until it expires on its own, every other pack renews as usual, and `scopebond status` and `scopebond packs list` name the pack, the version and why it was not used.
