# @scopebond/verify

## 0.1.1

### Patch Changes

- 875d640: Publish one strict canonical JSON implementation and use it for verifier hashes and signatures across the Scopebond packages.
- Updated dependencies [875d640]
  - @scopebond/policy-schema@0.2.0

## 0.1.0

### Minor Changes

- First public release: the Scopebond policy vocabulary JSON Schemas (policy document
  and `scopebond:receipt`) and the deterministic `scopebond-verify` verdict library —
  `violates(policy, receipts, claimed)` with full v1 clause coverage and the reference
  conformance vector suite. Published as the early open standard (spec + vectors)
  ahead of the proxy.
