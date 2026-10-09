---
"@scopebond/hook": patch
---

The hook keeps the evidence-chain head each delivery answer carries in `chain-heads.json`, and `scopebond verify --anchor <file-or-url> [--segments <dir>]` checks the kept heads against a published day of anchors and, optionally, against evidence segments downloaded from the workspace. It exits non-zero when a chain went back below a head this computer kept, when one position names two segments, or when a kept head's segment is no longer in the chain.
