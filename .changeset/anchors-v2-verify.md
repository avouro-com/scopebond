---
"@scopebond/verify": minor
---

Add `@scopebond/verify/anchor`: WebCrypto-only verification for receipt-log anchors. v2 (`algo: "rfc9162-sha256"`) implements the RFC 9162 §2.1 Merkle Tree Hash with domain-separated leaves (`0x00`) and nodes (`0x01`) and no odd-node duplication, inclusion proofs (`inclusionProof`, `verifyInclusionProof`), consistency proofs (`consistencyProof`, `verifyConsistencyProof`), and Ed25519-signed anchors (`verifyAnchorSignature`, `verifyAnchorChain`). Legacy v1 (`sha256-merkle`) roots and anchor hashes keep verifying (`merkleRootV1`, `anchorHash`, `verifyAnchorRoot`). RFC 9162 reference vectors ship in `vectors/merkle-rfc9162.json`.
