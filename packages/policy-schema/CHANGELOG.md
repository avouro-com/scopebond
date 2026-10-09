# @scopebond/policy-schema

## 0.7.1

### Patch Changes

- 52502c3: The same action gets the same treatment in Claude Code, Codex and Cursor.
  
  - Cursor is answered `allow` only for a clean evaluated allow. An action a monitored rule finds out of policy now gets no
    opinion (`ask`), so Cursor's own approval decides, as Claude Code's and Codex's do when the hook stays silent.
  - A Cursor edit reported after it was written (`afterFileEdit`) that breaks a blocking rule is signed with the new execution
    state `observed_after` (`realtime_result: "deny"`, `executed: true`) instead of `denied`. `log` shows it as "recorded, not
    prevented", the tray and local counts keep it apart from blocks, and it is never counted as one. The gateway takes this as
    the `observedAfter` action option (nothing is dispatched and no override is asked); the receipt schema, evidence vectors
    and evidence check accept the new state.
  - The hook program answers deny on any failure the commands do not catch themselves (a module that cannot load, an uncaught
    error): Claude Code gets exit 2, Codex and Cursor their deny answer.
  - The Scopebond Agent checks the Codex and Cursor hook entries on each maintenance pass and keeps each outage (an entry that
    cannot start) as one `hook_unresolvable` delivery gap, which the rules check reports with the other gaps; `status` lists
    such outages apart from records that missed delivery.

## 0.7.0

### Minor Changes

- cb4d4e0: People may allow blocked actions for a while, or ask an admin. In the Scopebond window a person may choose **Allow once**,
  **Allow for 15 min**, **Always allow this here…** or **Ask an admin**, as the workspace allows. "For 15 min" and "always"
  leave a standing _allowance_ for the same action (the same type and parameters, whatever tool call it comes from): it is
  bound to one rule, expires (30 days by default), and never applies to Scopebond's own protection. A new rule mode, _Block,
  person may ask_, offers only **Ask an admin**: the action stays blocked and the request goes to the workspace, which answers
  with an allowance on the next rules check. The agent sends a person's allowances and requests to the workspace once, signed
  by the computer's enrolled key.

  The receipt of an action an allowance lets through carries `override.method: "allowance"`, with `repeat_of` naming the
  allowance and `reason_digest` the reason it was made with (receipt schema and `validateOverrideRecord`). The hook reports
  `x-scopebond-hook-capabilities: allowances` on its rules check, so a workspace sends the new mode and terms only to hooks that
  understand them.

  Also: the action key that recognises "the same action" leaves out the tool call's group size and position, so an earlier
  override's repeat window applies to the same command in any call.

  Review fixes before release: the floor check keeps a rule a person may only ask about blocking when another rule on the same
  action lets a person allow; the agent re-reads its files before writing, so an allowance or request the hook wrote during a
  send is kept; allowances and requests are signed over `scopebond:allowance/v1` and `scopebond:request/v1` domain lines;
  "Allow for 15 min" is offered only where the workspace sends the allowance terms; an older agent's "Allow once" on an
  ask-only rule becomes a request to an admin.

- e0f2de4: A session's heartbeat can be sent every five minutes instead of every minute, where the workspace says it reads the
  interval (`x-scopebond-heartbeat-interval-s` on the rules check). Each such heartbeat says so (`interval_s: 300`; the schema
  allows 60–900), and the workspace waits three intervals before calling a computer lost. A workspace that does not say gets
  heartbeats every minute without `interval_s`, as before. Heartbeats continue fifteen minutes after the last hook activity
  (it was ten), so an idle session still sends at least two.
- c877e45: Summary records. A signed `scopebond:summary` document (evidence class `summary`) stands in for many routine receipts when
  a computer sends its evidence: their number, an RFC 9162 root over the receipts it covers, counts by action type, result,
  program and working folder, and the actions repeated in the window. Every action keeps its own signed receipt; a denied,
  overridden, approved or timed-out action is never covered.

  - `@scopebond/policy-schema`: `summary.schema.json`, `summarySchema`, `SUMMARY_TYPE`, `SUMMARY_DOMAIN`, `SUMMARY_RESULTS`,
    `SUMMARY_LIMITS`.
  - `@scopebond/verify/summary`: `validateSummary`, `verifySummarySignature` (domain-separated, so a summary never passes as
    a receipt), `verifySummaryCoverage` (count, root, window, routine only, totals), `summaryRoot`, `summarySigningInput`.
  - `@scopebond/gateway`: `buildSummary` (signs with the receipts' key; at most 500 count lines, the rest folded by action
    type so the counts always add up), `isNotable` (the default test for what is always sent in full) and `repeatKey`.

## 0.6.0

### Minor Changes

- 433c8df: Warn mode. A workspace can set a rule to "Block, user may override": the hook then blocks a matching action until the person at the computer allows it once, with a reason, in the Scopebond Agent's window, or, where the workspace allows it and Claude Code's permission mode really asks the person, offers Claude Code's own prompt. Scopebond's own protection, rules on Block and the kill switch are never overridable; the workspace's daily limit and repeat window hold. The gateway takes an optional override handler on `handleAction` and signs an `override` record (rule, method, state, reason digest) into an approved receipt; `validateOverrideRecord` and the receipt schema define its exact shape.

## 0.5.0

### Minor Changes

- aac4f6f: Add the `scopebond:observation` v1 envelope: a closed JSON Schema (kind-specific data and typed operations), the domain-separated signing constants and `observationSigningInput`, and deterministic signature and hash vectors with negative cases. Receipts are unchanged.

### Patch Changes

- b08c8df: Every typed operation in the observation schema accepts an optional `approval_request_hash` (64 lowercase hex).

## 0.4.1

### Patch Changes

- f2e4d62: Canonicalization refuses malformed (lone-surrogate) strings instead of silently escaping them.

  `canonical()` serialized string values and object keys with `JSON.stringify`, which turns a lone UTF-16 surrogate into a `\udXXX` escape rather than rejecting it. RFC 8785 canonicalizes valid Unicode, and everything `canonical()` produces is signed — so a malformed string could enter a signature in a coerced form. It now throws `TypeError` on a lone surrogate (a high surrogate not followed by a low one, or an unpaired low surrogate) in any string value or key, consistent with how it already rejects non-finite numbers, sparse arrays and `undefined`. Valid surrogate pairs (astral characters) and ordinary non-ASCII text are unaffected.

## 0.4.0

### Minor Changes

- f212f82: Add a `force_push_guard` clause type. It denies a `git.push` that is a force-push to a protected branch (matched against `protected_refs`; glob, default `["main", "master", "release/*"]`), while still allowing ordinary pushes to those branches and force-pushes to feature branches. A force-push whose target ref cannot be resolved is denied (fail closed). This expresses a predicate a per-field `action_allowlist` bound cannot, since it must AND the `force` flag with a protected-ref set.

## 0.3.0

### Minor Changes

- ed6a822: Add Action Taxonomy v1 — the coding, GitHub, MCP and HTTP action types and their parameter bounds, as an extension of the policy vocabulary. `@scopebond/policy-schema` ships the machine-readable registry at `registry/actions-1.0.json` (exposed via the `./registry` subpath) with 11 action types (`shell.exec`, `file.read`, `file.write`, `git.push`, `package.install`, `net.fetch`, `http.call`, `mcp.tool.call`, `pr.open`, `pr.merge`, `deploy.release`), each declaring typed parameters, bound-ability, a risk class and emitting connectors. New exports: `actionRegistry`, `TAXONOMY_VERSION`, `getActionType(id)` and `validateActionParams(type, params)` (a structural parameter check — required present, declared parameters correctly typed; unknown types are reported, never silently allowed). Parameters are carried under `intent.params` and bound-able ones are constrained by an `action_allowlist` clause's `param_bounds`.

  `@scopebond/verify` adds taxonomy verdict conformance vectors (`vectors/taxonomy-verdicts.json`) proving the scalar bounds — enum, pattern, boolean-as-enum, omitted-parameter-denies — and the closed-allowlist deny of an unlisted action type, with no change to the `violates` engine. Array-parameter (e.g. `pr.*` `paths`) element-wise bounds are not yet expressible by `param_bounds` and await a separate vocabulary decision.

- 27be98a: Add element-wise array parameter bounds to `action_allowlist`. A param bound may now be `{ "items": <scalar bound>, "match": "all" | "any" }`, where `items` (`enum` / `min` / `max` / `pattern`) is applied to each element of an array parameter: `match: "all"` (default) requires every element to satisfy it, `match: "any"` requires at least one. This makes path policy expressible — e.g. deny a `pr.merge` whose `paths` touch `infra/prod/**` via `{ "paths": { "items": { "pattern": "^(?!infra/prod/).*" }, "match": "all" } }`.

  Fail-closed: a bounded array parameter that is absent or not an array denies; an empty array vacuously satisfies `match: "all"`. Array bounds are mutually exclusive with a top-level scalar bound, and `match` is only valid with `items` — enforced by `validatePolicy` and the JSON schema. Existing scalar bounds and policies are unchanged. Unblocks the GitHub App boundary connector's path-policy conformance.

- 973507f: Add signed boundary receipts. The evidence contract gains a `boundary` authorization mode — a clean representation for a receipt with **no agent signature**, where a gate attested a consequence and the identity is the receipt's boundary attribution (previously a boundary receipt would have had to misuse `insecure_development`). `@scopebond/policy-schema` adds the matching `authorization` variant to the closed receipt schema.

  `@scopebond/gateway` exports `buildBoundaryReceipt(input, attester)` — a reusable builder for any boundary-lane connector that constructs and signs a `boundary`-class receipt (gate, outcome_ref, attribution, the verdict and the pinned policy), mapping the verdict to an honest execution state (`deny` → `denied`, `allow` → `cooperative_allow`, `not_evaluated` → `observed_not_evaluated`, always `executed: false`).

  `@scopebond/github-action` uses it: with a signing key configured (`SCOPEBOND_ATTESTER_KEY`), the PR check emits a signed boundary receipt per PR head, verifiable offline, signed with the customer's own key in their runner. A `not_evaluated` (human) pull request emits none.

- 6417866: Add a `cooperative_allow` execution state to the receipt evidence contract. It records that an action was evaluated and allowed by policy but **not executed by the gateway** — the model for cooperative (M0 / check-only) enforcement, where the agent performs the action itself. Such a receipt is always `executed: false` with `external_effect: "not_independently_verified"`, so a cooperative allow is never labeled as executed. The verdict engine (`violates`) is unaffected: it evaluates the `executed` flag, not the execution state.
- 8ad0aab: Add the receipt evidence class (GATEWAY_SPEC §15 / D65): every receipt can carry an additive `evidence_class` of `signed_intent`, `pep_authorized` or `boundary`, so a verifier, the workspace and exports say how strong the evidence is without over-claiming.

  - `@scopebond/policy-schema` extends the closed `receipt.schema.json` with optional `evidence_class`, `principal` (required for `pep_authorized`) and `boundary` (`gate` ∈ merge/deploy/egress/platform_event, `outcome_ref`, `attribution` {kind: asserted|inferred, actor}; required for `boundary`), enforced by conditional schema rules, and exports `EVIDENCE_CLASSES`, `BOUNDARY_GATES`, `ATTRIBUTION_KINDS` and their types.
  - `@scopebond/gateway` tags its own signed-intent receipts explicitly, classifies legacy receipts at read time (`signed_intent` when an agent signature is present, else `pep_authorized`), and **never upgrades** an explicitly set class. `verifyReceipt` now reports `evidence_class` and rejects a receipt whose class-required fields are missing or whose foreign class fields are smuggled in. New exports: `classifyEvidenceClass`, `EVIDENCE_CLASSES`, `BOUNDARY_GATES` and the `EvidenceClass`/`BoundaryGate`/`BoundaryEvidence`/`PepPrincipal` types.

  The envelope is otherwise unchanged and receipts emitted before this field still verify. A boundary-receipt builder is intentionally left to the boundary connector that will consume it.

- 1260a51: Add signed PEP-authorized receipts, completing the three-class receipt model. The evidence contract gains a `pep` authorization mode — the honest representation for a receipt with **no agent signature** where a proxy/PEP decided a request carrying the caller's own identity; the identity is the receipt's `principal`. `@scopebond/policy-schema` adds the matching `authorization` variant to the closed receipt schema.

  `@scopebond/gateway` exports `buildPepReceipt(input, attester)` — a reusable builder for any M1/PEP connector (the MCP proxy, gateway interceptors). It constructs and signs a `pep_authorized`-class receipt (the normalized action, the principal, the verdict and the pinned policy), mapping the verdict to an honest execution state (`deny` → `denied`, `allow` → `cooperative_allow`, `not_evaluated` → `observed_not_evaluated`, always `executed: false`). Like the boundary class, it attests only that the PEP authorized the action for the principal — never agent non-repudiation.

## 0.2.0

### Minor Changes

- 875d640: Publish one strict canonical JSON implementation and use it for verifier hashes and signatures across the Scopebond packages.
- Load the schema documents through bundleable JSON modules so strict validation also runs in edge Workers.

## 0.1.0

### Minor Changes

- First public release: the Scopebond policy vocabulary JSON Schemas (policy document
  and `scopebond:receipt`) and the deterministic `scopebond-verify` verdict library —
  `violates(policy, receipts, claimed)` with full v1 clause coverage and the reference
  conformance vector suite. Published as the early open standard (spec + vectors)
  ahead of the proxy.
