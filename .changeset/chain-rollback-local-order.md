---
"@scopebond/verify": patch
"@scopebond/gateway": patch
"@scopebond/hook": patch
---

A chain that went back is now reported even when the workspace stamps the lower head at or before a higher one it already handed out. The Cloud exporter hands `onChainHead` this computer's own delivery times (`{ sentAt, receivedAt }`), the chain-heads store keeps them beside each head (`local: { sent_at, received_at }`) and drops anything else the workspace put beside its signed head, and `checkChainHeads` also compares kept heads in the order this computer sent its deliveries, which the workspace cannot choose. `verifyAnchorList`, `verifyChainHeadSignature`, `checkChainHeads` and `verifySegmentChain` never throw on hostile input (a record that is not an object, text that is not well-formed Unicode, a key that is not a key), and `scopebond verify --anchor` reports such a list or segment as a problem instead of crashing.
