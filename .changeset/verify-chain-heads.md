---
"@scopebond/verify": patch
---

New `@scopebond/verify/chain`: checks the evidence-chain heads a workspace returns with each delivery and publishes each day. `verifyAnchorList` checks a published list (its key id, the list signature and every head signature), `checkChainHeads` checks that heads kept by a computer and published heads agree (a chain never goes back; one sequence position never names two segments), and `verifySegmentChain` checks downloaded evidence segments against the heads (digests, canonical form, leaves, Merkle roots, links, sequence gaps, and the signature of every record that names a given key).
