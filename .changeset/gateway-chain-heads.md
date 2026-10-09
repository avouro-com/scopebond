---
"@scopebond/gateway": patch
---

The Cloud exporter hands the chain head a workspace returns with each delivery (`chain_head`) to a new `onChainHead` callback; a malformed head or a failing callback never affects delivery. `@scopebond/gateway/node` adds a small store for those heads (`chainHeadRecorder`, `readChainHeads`, `mergeChainHead`; `chain-heads.json`) that keeps each day's newest head per chain and every head that disagrees with the one before it. The chain checks from `@scopebond/verify/chain` are re-exported.
