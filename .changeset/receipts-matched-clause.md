---
"@scopebond/policy-schema": patch
"@scopebond/verify": patch
"@scopebond/gateway": patch
---

Receipts now name the policy clause that matched and the bound that failed.

- policy-schema: the receipt schema adds two optional payload members, `clause_id` and `failed_bound` (`<param>:<bound>`, never the param's value), with valid and invalid examples in `vectors/evidence-contract.json`; receipts without them are unchanged.
- verify: a verdict that names a clause now also names the bound that failed (`failed_bound`), and among matching clauses of one mode it names the first by policy order; the conformance vectors check the bound too.
- gateway: denied, monitored, held and overridden receipts carry `clause_id` and `failed_bound`, an allowed one carries neither, and `validateEvidencePayload` checks them.
