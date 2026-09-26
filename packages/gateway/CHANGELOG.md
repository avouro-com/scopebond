# @scopebond/gateway

## 0.8.0

### Minor Changes

- 978e7a3: Make the limits editable, bound what the hook writes to disk, and make `install` safe to
  try.

  - **`rules` — the limits in plain terms.** `policy.json` is 6.7 KB of generated regular
    expression (the `safe-shell` clause alone is a ~700-character case-folded negative
    lookahead), so "it is a plain JSON file — edit the limits" was not true in practice and
    the starter policy was effectively the only policy. The lists those patterns are built
    from now live in `.scopebond/rules.json`, and `policy.json` is compiled from them:

    ```
    scopebond-hook rules                    # what is blocked, in plain English
    scopebond-hook rules allow dd
    scopebond-hook rules protect infra/
    scopebond-hook rules protect-branch production
    scopebond-hook rules apply              # recompile after editing rules.json by hand
    ```

    The compiled patterns are **identical** to the ones already shipped — a test pins them
    against `starterPolicy()`, so the readable front end cannot change what is enforced.
    Clause descriptions are now generated from the lists, so they stay true after an edit
    (and the block message quotes them).

  - **The local store stops growing without bound.** The hook is one short-lived process per
    tool call, and it never closed its SQLite handle — so each process left its write-ahead
    log on disk for the next one to extend. Measured: **~11 KiB of WAL per receipt, against
    ~1.7 KiB once the handle is closed**, and the WAL file is now gone entirely after a run.
    (It also released a Windows file lock that stopped `.scopebond` being removable.)
    `ReceiptStore` gains optional `recent(limit)` and `count()`; both stores implement
    `close()` with a truncating checkpoint.

  - **`prune` bounds the store, without ever losing evidence quietly.** `status` now reports
    the receipt count and size, and `prune --before 90d` archives the receipts it will
    remove to a JSONL file beside the database before removing them, then VACUUMs. It
    refuses outright once the log has been anchored, because a receipt's position is its
    anchor leaf index and removing one would make an existing anchor unverifiable. Nothing
    is ever deleted automatically.

  - **`log` answers "what got blocked this week".** It had no filters and read every receipt
    ever recorded in order to print the last 20. It now takes `--deny` and `--since 7d`, and
    reads a tail (`ORDER BY id DESC LIMIT`) with a bounded scan when filtering. `verify`
    still reads everything — that is the point of it — but reports progress instead of
    looking hung on a long history.

  - **`install --dry-run`, and a backup before any change.** `install` rewrites agent config
    files the user did not create (`~/.claude/settings.json` holds their theme, plugins and
    permissions) and the undo was "hope the merge was right". It now prints exactly which
    files it would touch with `--dry-run`, and copies each config to
    `<file>.scopebond-backup` before its first modification.

  - **Fixed: `uninstall` ignored the project hook.** Like `status` and `doctor` before it, it
    looked only at the user-level config — so after the per-project `init` the site tells
    people to run, it reported "no user-level harness config found" and left the hook in
    place. It now removes both scopes and says what it kept.

  - **Per-command help.** `--help` was a single line listing 15 command names. `help` now
    describes each command, and `help <command>` gives its arguments and an example.

  Known remaining inefficiency: the authority tables store the policy snapshot per action,
  so a tool call costs ~25 KiB rather than the ~2 KiB of the receipt itself. Deduplicating
  it by digest needs a schema migration in the authority storage that backs duplicate-action
  detection, so it is deliberately left for its own change rather than bundled here.

### Patch Changes

- 978e7a3: Fix `verifier_version`: receipts named a verifier that did not produce their verdict.

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

- Updated dependencies [978e7a3]
  - @scopebond/verify@0.4.1

## 0.7.0

### Minor Changes

- df4fc67: Anchors v2: `gateway.anchor()` now writes RFC 9162 anchors (`algo: "rfc9162-sha256"`, `tree_size`, `root`, `prev_anchor_hash`) signed with the attester key, chained to the last existing (v1) anchor, and refuses to sign when the receipt log no longer reproduces the previous anchor. `GET /v1/anchors/proof` returns the audit path (`leaf_index`, `tree_size`, `audit_path`) and the signed anchor for the client to verify, accepts `anchor_seq`, and no longer returns a server-computed `included` flag; `GET /v1/anchors/consistency` returns RFC 9162 consistency proofs. `merkleRoot`, `merkleProof`, `verifyProof`, `canonical` and `sha256` are unchanged; the v2 functions from `@scopebond/verify/anchor` are re-exported. The `Anchor` type is now `AnchorV1 | AnchorV2`.

### Patch Changes

- 5329932: Local stores tolerate concurrent writers and crashes. SQLite stores (receipts and the Cloud outbox) open with WAL and a 5-second busy timeout, so parallel hook processes wait for the lock instead of failing with SQLITE_BUSY. `openReceiptStore` falls back to a JSONL file only when `node:sqlite` is unavailable, and then beside the requested database rather than in the current directory; a database that exists but cannot be opened is now an error instead of a silent switch to another log. The JSONL store truncates a torn final line left by a crash and refuses a corrupt record anywhere else.
- Updated dependencies [df4fc67]
- Updated dependencies [f2e4d62]
- Updated dependencies [792c40f]
- Updated dependencies [a488918]
  - @scopebond/verify@0.4.0
  - @scopebond/policy-schema@0.4.1

## 0.6.1

### Patch Changes

- 7343f01: Register the hook's separate agent signing key during enrollment using a challenge signed by both keys. Require the server to acknowledge that key before saving the connection, so authenticated receipts can be uploaded. Let doctor and flush exit normally after network requests to avoid a Windows shutdown assertion.
- Updated dependencies [f212f82]
  - @scopebond/policy-schema@0.4.0
  - @scopebond/verify@0.3.0

## 0.6.0

### Minor Changes

- 4dd6919: Make stateful clauses (rate_limit, spend_limit, sequence) bind in cooperative
  (check_only) enforcement.

  Previously a cooperative allow was recorded `executed:false`, and windowed clauses
  count only executed actions, so a per-window spend cap, a rate limit or a sequence
  cooldown never triggered in check-only mode — "max 5 posts a day" or "max
  $100/day" silently never fired. The gateway now counts prior cooperative allows
  toward the window for the live decision (an in-memory coercion in `evaluate`);
  stored receipts keep `executed:false` and claim-time `violates()` is unchanged, so
  this is conservative by design — an authorized-but-skipped action counts, which
  over-restricts rather than under. The MCP proxy previously evaluated every call
  against an empty history, so the same clauses never bound; it now keeps a session
  history of authorized calls (seedable via a new `history` option) and passes it to
  `violates()`, so rate_limit and sequence clauses work across calls. The in-process
  framework guard inherits the fix through the gateway.

## 0.5.0

### Minor Changes

- 973507f: Add signed boundary receipts. The evidence contract gains a `boundary` authorization mode — a clean representation for a receipt with **no agent signature**, where a gate attested a consequence and the identity is the receipt's boundary attribution (previously a boundary receipt would have had to misuse `insecure_development`). `@scopebond/policy-schema` adds the matching `authorization` variant to the closed receipt schema.

  `@scopebond/gateway` exports `buildBoundaryReceipt(input, attester)` — a reusable builder for any boundary-lane connector that constructs and signs a `boundary`-class receipt (gate, outcome_ref, attribution, the verdict and the pinned policy), mapping the verdict to an honest execution state (`deny` → `denied`, `allow` → `cooperative_allow`, `not_evaluated` → `observed_not_evaluated`, always `executed: false`).

  `@scopebond/github-action` uses it: with a signing key configured (`SCOPEBOND_ATTESTER_KEY`), the PR check emits a signed boundary receipt per PR head, verifiable offline, signed with the customer's own key in their runner. A `not_evaluated` (human) pull request emits none.

- 6417866: Add a `cooperative_allow` execution state to the receipt evidence contract. It records that an action was evaluated and allowed by policy but **not executed by the gateway** — the model for cooperative (M0 / check-only) enforcement, where the agent performs the action itself. Such a receipt is always `executed: false` with `external_effect: "not_independently_verified"`, so a cooperative allow is never labeled as executed. The verdict engine (`violates`) is unaffected: it evaluates the `executed` flag, not the execution state.
- 8ad0aab: Add the receipt evidence class (GATEWAY_SPEC §15 / D65): every receipt can carry an additive `evidence_class` of `signed_intent`, `pep_authorized` or `boundary`, so a verifier, the workspace and exports say how strong the evidence is without over-claiming.

  - `@scopebond/policy-schema` extends the closed `receipt.schema.json` with optional `evidence_class`, `principal` (required for `pep_authorized`) and `boundary` (`gate` ∈ merge/deploy/egress/platform_event, `outcome_ref`, `attribution` {kind: asserted|inferred, actor}; required for `boundary`), enforced by conditional schema rules, and exports `EVIDENCE_CLASSES`, `BOUNDARY_GATES`, `ATTRIBUTION_KINDS` and their types.
  - `@scopebond/gateway` tags its own signed-intent receipts explicitly, classifies legacy receipts at read time (`signed_intent` when an agent signature is present, else `pep_authorized`), and **never upgrades** an explicitly set class. `verifyReceipt` now reports `evidence_class` and rejects a receipt whose class-required fields are missing or whose foreign class fields are smuggled in. New exports: `classifyEvidenceClass`, `EVIDENCE_CLASSES`, `BOUNDARY_GATES` and the `EvidenceClass`/`BoundaryGate`/`BoundaryEvidence`/`PepPrincipal` types.

  The envelope is otherwise unchanged and receipts emitted before this field still verify. A boundary-receipt builder is intentionally left to the boundary connector that will consume it.

- 0cb916f: Add `scopebond-gateway init [--force]`. It scaffolds a working project — an Ed25519 agent signing key, a `principal-keys.json` registry that trusts that key, and a starter `scopebond.policy.json` bound to it — then prints the start, sign, submit and verify steps with a one-time control token that is never written to disk. A refused run (an existing registry or policy without `--force`) now leaves the directory untouched, generating no agent key.
- c17c1fb: `buildPepReceipt` and `buildBoundaryReceipt` now set a deterministic `action_ref.action_id`, so PEP-authorized and boundary receipts carry the idempotency key the durable Cloud outbox and the ingest use. Boundary receipts key on `(gate, outcome_ref, intent)` (re-evaluating the same PR head dedupes); PEP receipts key on `(intent, timestamp, principal)` (unique per authorized call, deterministic under an injected clock). Without this, those receipt classes could not be enqueued for export.
- 1fd3470: Wire up M0 (check-only / cooperative) enforcement. `createGateway({ mode: "check_only" })`, the `serve --check-only` flag and `SCOPEBOND_MODE=check_only` make an allowed action a **cooperative allow**: the gateway decides and countersigns but never dispatches to an executor, recording `execution.state: "cooperative_allow"` (always `executed: false`, `external_effect: "not_independently_verified"`). A new `gateway.check(req)` forces the same cooperative semantics regardless of the configured mode, so an agent can obtain a decision plus a portable signed receipt in-process with no HTTP server. Denials and the kill switch remain fail-closed, and replayed signed requests are still rejected.

  A cooperative allow is never counted as executed — not even transiently while reserved — so it cannot inflate a spend window it did not dispatch. Cumulative window enforcement across cooperative allows is therefore not provided in M0 by design; the per-action decision still applies, and in-path dispatch mode remains the way to enforce cumulative budgets. Also fixes the MCP `serverInfo.version` (previously reported `0.0.0`).

- 1260a51: Add signed PEP-authorized receipts, completing the three-class receipt model. The evidence contract gains a `pep` authorization mode — the honest representation for a receipt with **no agent signature** where a proxy/PEP decided a request carrying the caller's own identity; the identity is the receipt's `principal`. `@scopebond/policy-schema` adds the matching `authorization` variant to the closed receipt schema.

  `@scopebond/gateway` exports `buildPepReceipt(input, attester)` — a reusable builder for any M1/PEP connector (the MCP proxy, gateway interceptors). It constructs and signs a `pep_authorized`-class receipt (the normalized action, the principal, the verdict and the pinned policy), mapping the verdict to an honest execution state (`deny` → `denied`, `allow` → `cooperative_allow`, `not_evaluated` → `observed_not_evaluated`, always `executed: false`). Like the boundary class, it attests only that the PEP authorized the action for the principal — never agent non-repudiation.

### Patch Changes

- Updated dependencies [ed6a822]
- Updated dependencies [c0d81f6]
- Updated dependencies [27be98a]
- Updated dependencies [973507f]
- Updated dependencies [6417866]
- Updated dependencies [8ad0aab]
- Updated dependencies [1260a51]
  - @scopebond/policy-schema@0.3.0
  - @scopebond/verify@0.2.0

## 0.4.1

### Patch Changes

- b434d38: Add a bounded CLI enrollment flow that proves possession of the gateway attester key and returns scoped Cloud exporter configuration only to the gateway terminal.

## 0.4.0

### Minor Changes

- 2dabf5f: Publish the authenticated evidence SDK and add scoped-machine Cloud export with a
  bounded durable SQLite outbox, duplicate-safe acknowledgement, retry backoff and
  explicit delivery-gap status.

### Patch Changes

- Updated dependencies [875d640]
  - @scopebond/policy-schema@0.2.0
  - @scopebond/verify@0.1.1
