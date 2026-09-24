---
"@scopebond/verify": minor
---

Add `@scopebond/verify/signature`: `verifyReceiptSignature(receipt, publicKey)` verifies a receipt's Ed25519 attester signature over the RFC 8785 canonical payload and checks the attester key binding, using WebCrypto only so it runs in Node, browsers and Cloudflare Workers. Accepts SPKI PEM or an Ed25519 JWK; reserved algorithms and attester kinds are reported as unsupported. SPEC.md now states that v1 verifiers accept only Ed25519 from `gateway` attesters.
