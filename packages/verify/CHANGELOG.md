# @scopebond/verify

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
