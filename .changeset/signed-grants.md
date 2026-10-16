---
"@scopebond/hook": patch
---

Signed grants, and revocations that reach the computer.

- A rules document's `allowances`, `revoked_allowances`, `session_budgets` and `request_answers` are now checked against `grants_digest` (SHA-256 of their canonical JSON, absent members as `[]`) and `grants_signature` (Ed25519 by the document's key at its `issued_at`, over the rules payload with `kind: "grants"`). When either field is present both must be, the digest must match and the signature must verify; otherwise the answer is refused like a bad rules signature and the rules in force stay. In `enforce` mode a signed document that carries any of those lists without `grants_signature` is refused as `unsigned_policy`. Answers without the fields are still accepted in `dual` mode.
- A change to those lists alone, at the same revision and rules digest (for example a revoked allowance), is now installed instead of being treated as unchanged, so a revocation takes effect at the next rules check. An ETag saved by an earlier version is not sent once, so a revocation it missed is fetched again.
- New exports: `checkGrantsSignature`, `checkAnswerSignature`, `digestGrants`, `carriesGrants`, `GRANT_FIELDS`.
