---
"@scopebond/gateway": minor
---

Anchors v2: `gateway.anchor()` now writes RFC 9162 anchors (`algo: "rfc9162-sha256"`, `tree_size`, `root`, `prev_anchor_hash`) signed with the attester key, chained to the last existing (v1) anchor, and refuses to sign when the receipt log no longer reproduces the previous anchor. `GET /v1/anchors/proof` returns the audit path (`leaf_index`, `tree_size`, `audit_path`) and the signed anchor for the client to verify, accepts `anchor_seq`, and no longer returns a server-computed `included` flag; `GET /v1/anchors/consistency` returns RFC 9162 consistency proofs. `merkleRoot`, `merkleProof`, `verifyProof`, `canonical` and `sha256` are unchanged; the v2 functions from `@scopebond/verify/anchor` are re-exported. The `Anchor` type is now `AnchorV1 | AnchorV2`.
