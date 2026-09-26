---
"@scopebond/verify": patch
"@scopebond/gateway": patch
---

Fix `verifier_version`: receipts named a verifier that did not produce their verdict.

`SPEC.md` defines the receipt field `verifier_version` as "the `violates()` verifier version
that produced the verdict". It was a hardcoded literal `"scopebond-verify@0.1.1"` in
`@scopebond/gateway`, and it stayed that literal through `@scopebond/verify` 0.2, 0.3 and
0.4 — so for three releases every signed receipt asserted a verifier version that had not
evaluated it. This is visible in the wild: a receipt from the live demo today reports
`scopebond-verify@0.1.1` while the gateway there runs verify 0.4.0.

The value now comes from `VERIFIER_VERSION`, exported by `@scopebond/verify` next to
`violates()` itself, and a test pins it to that package's published version so it cannot
drift again. The identifier keeps its established `scopebond-verify@<version>` spelling —
only the wrong version is corrected, since receipts already in the wild carry that shape.

Receipts signed before this change are unaffected and still verify; they simply carry the
old, incorrect version string. Nothing else in the envelope, the canonicalization or the
signature changes.
