# @scopebond/verify

## 0.4.0

### Minor Changes

- df4fc67: Add `@scopebond/verify/anchor`: WebCrypto-only verification for receipt-log anchors. v2 (`algo: "rfc9162-sha256"`) implements the RFC 9162 §2.1 Merkle Tree Hash with domain-separated leaves (`0x00`) and nodes (`0x01`) and no odd-node duplication, inclusion proofs (`inclusionProof`, `verifyInclusionProof`), consistency proofs (`consistencyProof`, `verifyConsistencyProof`), and Ed25519-signed anchors (`verifyAnchorSignature`, `verifyAnchorChain`). Legacy v1 (`sha256-merkle`) roots and anchor hashes keep verifying (`merkleRootV1`, `anchorHash`, `verifyAnchorRoot`). RFC 9162 reference vectors ship in `vectors/merkle-rfc9162.json`.
- 792c40f: Security: `force_push_guard` now covers branch deletion and all-branch pushes, and its default protects nested release branches.

  The clause previously fired only on a `--force` push whose single resolved ref matched the protected set. Three destructive pushes slipped through:

  - **Deletion** (`git push origin :main`, `git push origin --delete main`) removes a protected branch and is destructive even without `--force`; it was treated as an ordinary push.
  - **All-branch force pushes** (`git push --all --force`, `git push --mirror`) reach every branch — so they necessarily rewrite the protected ones, and `--mirror` also prunes — but their whole-repo push carried no single protected ref to match.
  - The default protected set was `["main", "master", "release/*"]`; the single-star glob does not cross `/`, so `release/1.0/hotfix` was unprotected. The default is now `release/**`.

  The hook mapper marks these on the `git.push` intent it emits (`delete` for `:dst`/`--delete`, `all` for `--all`/`--mirror`/`--branches`), and `force_push_guard` denies a delete of a protected ref (regardless of `force`), a force-push to all branches, and a force-push to a protected ref, still allowing ordinary pushes, feature-branch force-pushes and a non-forced `--all`. A destructive push whose target ref cannot be resolved still fails closed. The hook's own starter policy already denied these through its stricter ref allowlist; this closes the gap for customer policies that use the `force_push_guard` clause.

- a488918: Add `@scopebond/verify/signature`: `verifyReceiptSignature(receipt, publicKey)` verifies a receipt's Ed25519 attester signature over the RFC 8785 canonical payload and checks the attester key binding, using WebCrypto only so it runs in Node, browsers and Cloudflare Workers. Accepts SPKI PEM or an Ed25519 JWK; reserved algorithms and attester kinds are reported as unsupported. SPEC.md now states that v1 verifiers accept only Ed25519 from `gateway` attesters.

### Patch Changes

- Updated dependencies [f2e4d62]
  - @scopebond/policy-schema@0.4.1

## 0.3.0

### Minor Changes

- f212f82: Add a `force_push_guard` clause type. It denies a `git.push` that is a force-push to a protected branch (matched against `protected_refs`; glob, default `["main", "master", "release/*"]`), while still allowing ordinary pushes to those branches and force-pushes to feature branches. A force-push whose target ref cannot be resolved is denied (fail closed). This expresses a predicate a per-field `action_allowlist` bound cannot, since it must AND the `force` flag with a protected-ref set.

### Patch Changes

- Updated dependencies [f212f82]
  - @scopebond/policy-schema@0.4.0

## 0.2.0

### Minor Changes

- 27be98a: Add element-wise array parameter bounds to `action_allowlist`. A param bound may now be `{ "items": <scalar bound>, "match": "all" | "any" }`, where `items` (`enum` / `min` / `max` / `pattern`) is applied to each element of an array parameter: `match: "all"` (default) requires every element to satisfy it, `match: "any"` requires at least one. This makes path policy expressible — e.g. deny a `pr.merge` whose `paths` touch `infra/prod/**` via `{ "paths": { "items": { "pattern": "^(?!infra/prod/).*" }, "match": "all" } }`.

  Fail-closed: a bounded array parameter that is absent or not an array denies; an empty array vacuously satisfies `match: "all"`. Array bounds are mutually exclusive with a top-level scalar bound, and `match` is only valid with `items` — enforced by `validatePolicy` and the JSON schema. Existing scalar bounds and policies are unchanged. Unblocks the GitHub App boundary connector's path-policy conformance.

### Patch Changes

- ed6a822: Add Action Taxonomy v1 — the coding, GitHub, MCP and HTTP action types and their parameter bounds, as an extension of the policy vocabulary. `@scopebond/policy-schema` ships the machine-readable registry at `registry/actions-1.0.json` (exposed via the `./registry` subpath) with 11 action types (`shell.exec`, `file.read`, `file.write`, `git.push`, `package.install`, `net.fetch`, `http.call`, `mcp.tool.call`, `pr.open`, `pr.merge`, `deploy.release`), each declaring typed parameters, bound-ability, a risk class and emitting connectors. New exports: `actionRegistry`, `TAXONOMY_VERSION`, `getActionType(id)` and `validateActionParams(type, params)` (a structural parameter check — required present, declared parameters correctly typed; unknown types are reported, never silently allowed). Parameters are carried under `intent.params` and bound-able ones are constrained by an `action_allowlist` clause's `param_bounds`.

  `@scopebond/verify` adds taxonomy verdict conformance vectors (`vectors/taxonomy-verdicts.json`) proving the scalar bounds — enum, pattern, boolean-as-enum, omitted-parameter-denies — and the closed-allowlist deny of an unlisted action type, with no change to the `violates` engine. Array-parameter (e.g. `pr.*` `paths`) element-wise bounds are not yet expressible by `param_bounds` and await a separate vocabulary decision.

- c0d81f6: Add conformance vectors for the array-parameter bound's `match: "any"` mode and edge cases (at least one element must satisfy the item bound; an empty array denies under `match: "any"`; a non-string element denies a pattern bound). The behavior was already correct; these lock it in against regression.
- Updated dependencies [ed6a822]
- Updated dependencies [27be98a]
- Updated dependencies [973507f]
- Updated dependencies [6417866]
- Updated dependencies [8ad0aab]
- Updated dependencies [1260a51]
  - @scopebond/policy-schema@0.3.0

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
