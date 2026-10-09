# @scopebond/gateway

## 0.17.4

### Patch Changes

- 58fa74d: The agent keeps answering while it works. The local store's upkeep (up to 30 seconds of database work, or a full rewrite
  of an older file) now runs as `scopebond-agent upkeep` in a process of its own, so the tray, `status` and the workspace's
  requests are answered meanwhile. One cycle sends for at most a minute and the next cycle starts at once while records
  remain, so a long queue never holds up the rules check. The gateway's exporter lets the event loop run between batches
  and takes `flush({ maxMs })`: no new batch starts once that time is up.
- 4e6ceff: The Cloud exporter hands the chain head a workspace returns with each delivery (`chain_head`) to a new `onChainHead` callback; a malformed head or a failing callback never affects delivery. `@scopebond/gateway/node` adds a small store for those heads (`chainHeadRecorder`, `readChainHeads`, `mergeChainHead`; `chain-heads.json`) that keeps each day's newest head per chain and every head that disagrees with the one before it. The chain checks from `@scopebond/verify/chain` are re-exported.
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
- Updated dependencies [52502c3]
- Updated dependencies [4e6ceff]
  - @scopebond/policy-schema@0.7.1
  - @scopebond/verify@0.6.2

## 0.17.3

### Patch Changes

- 0225f33: The attester key and the dispatch binding key are now created exclusively with owner-only permissions (a damaged binding key is replaced atomically), `init` claims its files with an exclusive create, and dispatch and approval files are size-checked on the same open file they are read from.

## 0.17.2

### Patch Changes

- b9c0504: Each delivery batch's record numbers are now signed with the computer's enrolled key. The Cloud exporter takes an optional `sequenceProof` (the attester and the machine credential's id) and sends `seq_proof: { kid, signature }` beside `seq` and `queue`, over `"scopebond:delivery-sequence/v1\n"` followed by the canonical JSON of the credential id, the queue id, the numbers and the SHA-256 of each receipt as sent. A party holding only the bearer credential can no longer attach numbers to records of its choosing. The hook and the agent sign with the key that signs their receipts; an exporter without a key sends the numbers unsigned, as before.

## 0.17.1

### Patch Changes

- 258cdb6: Records that miss normal delivery are now kept, put right and reported.

  - When a receipt is written locally but its delivery-queue write fails (the queue cannot be opened, or another process holds its lock), the action stays allowed and recorded on the computer as before. The miss is now noted, kept as an `outbox_error` gap on the next flush, and the receipt is queued then (every receipt written since the miss that the queue does not know yet, in log order). A tool call waits at most 2 seconds for the queue's lock, so an override wait plus a lock wait stays inside the coding agent's hook time limit; after an override wait, the local log also waits less for its lock. `flush` and the Scopebond Agent keep the longer wait.
  - An evaluation stopped between its reservation and its receipt (a hook time limit, a crash) is closed after five minutes by the next hook call or the Scopebond Agent, with a signed receipt whose outcome is unknown (`execution.state: outcome_unknown`, reference `scopebond:evaluation-interrupted`, the policy's decision kept), queued like any other.
  - The delivery queue keeps a lifetime count of gaps per reason (`status().gapsByReason`), beside the lifetime total; the gap rows themselves are still trimmed to the newest 10,000. `SqliteCloudOutbox` takes a `busyTimeoutMs` option and has `setBusyTimeout()` and `known()`; `SqliteReceiptStore` has `interruptedActions()`, `settleAction()`, `lastId()` and `setBusyTimeout()`.
  - The rules check sends `x-scopebond-gaps-total` (the lifetime total) and `x-scopebond-gaps-by-reason` (compact JSON of reason code to count) when the queue has any gaps. `status` and `doctor` show a "delivery gaps" line, and `status --json` adds `delivery.gaps_total` and counts `delivery.gaps_by_reason` over the queue's lifetime.
  - The status texts no longer say an unusable delivery queue blocks every action: actions stay allowed and recorded on the computer, and are sent once the queue can be written again.

- d6996ad: Delivery no longer stalls on a request that never answers. Each delivery request now has a time limit (30 seconds by default, `requestTimeoutMs`), and the limit also covers reading the answer.

  The Scopebond Agent:

  - caps each delivery cycle at 10 minutes and goes on to the next cycle;
  - starts its maintenance before the first cycle;
  - answers Send now and stop without waiting on a stuck cycle;
  - reports when the running cycle started (`cycle_started_at` in `/status`).

  The hook:

  - waits on a flush that is already sending instead of returning at once, so a backlog of 100 or more records drains from hook calls;
  - records a cut-off only when its time limit really ran out;
  - no longer replaces the agent's recent delivery error with its own cut-off message.

  An agent that the workspace's plan paused now says so in the tray and in `status`, instead of offering Send records now.

  The rules check now sends `x-scopebond-accepts-requests`: `flush,self_check` from the agent and `none` from a hook call. A workspace that reads the header then leaves a request from its computer page (send now, check now) for the agent.

- 7fc5efb: Self-hosted gateway hardening.

  - **HTTP executor:** an allowed `http.call` now reaches only the host its policy checked. The executor builds the URL with `new URL`, requires a path that starts with a single `/`, and checks the parsed host again. Before, a path such as `@other.example/x` sent the call to another host.
  - **Host lists:** `endpoint_allowlist` and `endpoint_denylist` compare hosts as an HTTP client resolves them, ignoring case and one trailing dot. A host that is not a bare name or address, or a path that does not start with `/`, is never allowed and counts as denied.
  - **Request bodies:** every request body is limited to 1 MiB (`maxBodyBytes`) before it is read, and JSON nested deeper than 64 levels is refused. MCP errors no longer echo internal exception text.
  - **File access:** key files, the receipt database and the JSONL logs are readable by their owner alone. On Windows the inherited access list is replaced with the current user and SYSTEM; on POSIX the mode is 0600.
  - **Anchor proofs:** leaf hashes are computed once instead of on every request. A lookup by `intent_hash` needs the control token; a lookup by leaf hash stays public.

- 0f7268b: Receipts now scrub credential shapes inside string values, not only under credential-named keys: a credential-named URL query parameter, URL userinfo, a SQL password literal, an `Authorization:` header or credential-like `NAME=value` in a command, and well-known token formats are replaced with `***` before a receipt is signed, stored or exported (the `/v1/evaluate` and MCP ingress paths, the in-process check, and the PEP and boundary receipt builders). Each scrubbed path is listed in `redaction.paths`; `action_type`, `asset`, `amount` and `currency` are kept exactly as given. The scrubber is exported as `scrubSecretText`. A summary's `cwd_digest` is now an HMAC under a key passed as `digestKey` (in `buildSummary` options and in the exporter's `summaries` options) instead of a plain SHA-256, so a folder path cannot be confirmed by hashing a guess; without a key, a random key for the process is used. A record a bounded outbox drops at capacity now takes its sequence number before it is dropped (the gap carries it as `seq`), so the workspace counts it as missing. New `LOSSLESS_CLOUD_OUTBOX` options (no cap, no expiry) for exporters that must not drop records.
- Updated dependencies [7fc5efb]
  - @scopebond/verify@0.6.1

## 0.17.0

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

- ce7728c: A small, steady local store. A hook call's memory and time no longer grow with the local history: the replay check is one
  indexed lookup instead of reading every receipt (a call on a 767 MB log peaked at 69 MB, down from 233 MB, and 504 MB for a
  three-part shell command; it took 0.26 s instead of 1–1.8 s). The SQLite store keeps each policy once and each receipt once,
  and keeps nothing for an action that finished without being dispatched; a log from an earlier version is rewritten to this
  layout and shrinks (767 MB became 93 MB with every receipt kept).

  Receipts a workspace acknowledged are removed 30 days after it did (the workspace can set 7–365 days); a receipt it has not
  acknowledged is never removed, an anchored log is never pruned, and a computer with no workspace keeps everything. The
  Scopebond Agent runs this upkeep; a hook-only install runs a short pass once a day and leaves rewriting an older file to a
  background process. `prune` reports the retention, and `prune --compact` runs the upkeep now.

  Also: `sed -n a,bp f` reads `f`, not a file named after the script; `cat $f` no longer records a read of a file called `$f`;
  Scopebond's own folder named in an interpreter's arguments (`node -e`, `python script.py ~/.scopebond/…`, `sqlite3`) is
  treated as a read of it; `rules.json` and `cloud.json` are read once per call; the delivery queue keeps its totals.
  `@scopebond/gateway` adds `ReceiptStore.authorizationUsed`, `SqliteReceiptStore.maintain`, `SqliteCloudOutbox.markAcknowledged`
  and `pendingCount`, and re-exports `historyNeed`.

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

- d4b34d8: Send summaries instead of every routine receipt when the workspace asks for it. The workspace names its evidence detail on
  each rules check (`x-scopebond-evidence-detail: full | standard`); the hook keeps it beside the local retention. With
  _standard_, the exporter sends notable receipts in full at once and the routine ones of each closed five-minute window as one
  signed summary (`POST /v1/summaries`, with the queue's record numbers it stands for beside it, so the workspace's gap check
  stays exact). Each window is summarised once per queue (a claim in the outbox), so a window's summary covers exactly its
  routine receipts that were not sent in full; a record that turns up for a window already summarised is sent in full. A
  workspace without summaries (404, 405) or that refuses one (400, 413, 422) is sent every receipt, as before.

  Also: enqueueing never starts a flush while summaries are on, and a hook call's flush runs only when the call recorded
  something notable (`flush({ routine: false })`); the agent's cycle and `scopebond-hook flush` send the summaries. New:
  `CloudSummaryOptions`, `seqRanges`, outbox `claimWindow`/`releaseWindow`; hook `evidenceDetail`, `evidenceDetailFrom`,
  `summaryOptions`. A 1,000-action session over 20 minutes ships 4 summaries and its 5 pushes.

  Review fixes before release: a window's claim is a lease, so a window another process is sending waits instead of also going
  in full, and a claim a process abandoned is taken over under the same summary id; records leave the queue only for the
  summaries the workspace says it has (a summary it refused sends its records in full; a short answer is retried under the
  same ids); a summary's `notable_count` counts the window's records sent in full, kept in the outbox; notable records go
  before summaries; a computer without the agent sends summaries from a hook call once routine records have waited 30 minutes.

### Patch Changes

- e343292: Groundwork for a single-file Windows build. The hook's and the agent's commands are now `main(argv)` functions in `cli-main.js` (the `cli.js` programs that agent settings and autostart name are unchanged and call them); every place that starts the hook or the agent again goes through one helper (`hookSelfCommand`, `agentCliPath`); Node's SQLite is taken from Node's built-ins; versions can be set at build time. No change in behaviour for npm installs.
- Updated dependencies [cb4d4e0]
- Updated dependencies [e0f2de4]
- Updated dependencies [c877e45]
  - @scopebond/policy-schema@0.7.0
  - @scopebond/verify@0.6.0

## 0.16.2

### Patch Changes

- 2dac3d7: Several checks opening the local log at the same moment no longer fail closed with "database is locked" on Windows. Switching a log to WAL takes a lock that SQLite's busy timeout does not always wait for, so that one step now retries for up to 15 seconds. The hook also no longer counts its own signing key (`agent.key`) as a sign that the Scopebond Agent is installed, so `doctor` passes on a computer without the agent.

## 0.16.1

### Patch Changes

- 5a2902f: gateway, hook: two coding agents on one computer no longer make each other's checks fail with "database is locked". A process now ends with a passive checkpoint instead of an exclusive truncating one (which waited for every other process and blocked writers meanwhile), and waits up to 15 seconds for the write lock instead of 5. A lock that still times out says what it is, instead of suggesting `init`.

  agent: an update hands over reliably. Hook entries move to the recommended hook before the agent updates itself, so a failed handover never leaves the hook behind, and the old agent exits within 5 seconds even if stopping its window or tray hangs, instead of staying alive while its replacement waits.

## 0.16.0

### Minor Changes

- 40c1fb7: Cloud delivery compresses a batch with gzip once the workspace has said it reads gzip (`Accept-Encoding: gzip` on an ingest answer) and the batch is at least 1 KiB (`gzipMinBytes`; 0 turns it off). A workspace that never says so keeps receiving plain JSON, so older workspaces are unaffected.

## 0.15.0

### Minor Changes

- 9fd79e2: A tool call no longer gets slower as the receipt log grows. Each decision reads only the history its policy can see: none for allowlists and guards (the coding-agent starter policies), and only the longest window or sequence gap for `rate_limit`, `spend_limit` and `sequence`. At 10,000 stored receipts a starter-policy decision went from more than 60 ms to under 1 ms, and it stays flat as the log grows. Decisions are unchanged; the tests check every conformance vector, every verdict test and randomized histories with and without the bound.

  New in `@scopebond/verify`: `historyNeed(policy)` and `boundPrior(need, receipts, at)`, which define the bounded set exactly; a live verdict's `inputs_hash` commits to that set. New in `@scopebond/gateway`: `ReceiptStore.executed(scope)` and `reserveAction(…, scope)` take an optional `PriorScope`, and `SqliteReceiptStore` adds an index on `receipts.timestamp` when it opens. A store that ignores `scope` stays correct, only slower.

### Patch Changes

- Updated dependencies [9fd79e2]
  - @scopebond/verify@0.5.0

## 0.14.0

### Minor Changes

- c4514ca: Each delivery queue has its own id, made once when the queue is created, and the exporter sends it beside the record numbers. The hook's rules check reports the queue id and the highest number the queue has given a record (`x-scopebond-queue-id`, `x-scopebond-seq-assigned`), so a workspace can tell numbering that restarted because the queue was removed from a resend, and count the records that queue never delivered.
- 7736223: Sequenced delivery: the Cloud outbox gives each queued record this computer's number for it (1, 2, 3… in queue order, kept across restarts and never reused), and the exporter sends the numbers beside the receipts (`{ receipts, seq }`; the signed receipts are unchanged). A workspace that reads them can show records lost on the computer, for example aged out of the queue, as missing instead of silently absent. Queues made before this are upgraded in place; their waiting records stay unnumbered.

### Patch Changes

- 8e42db0: A record the workspace refuses only because this computer's clock is ahead of its own (`future_timestamp`) stays in the queue and is sent again, since it is accepted once the time passes; the records around it still deliver. Before, it was settled as a lost record when it shared a batch with others. After a day it is settled as a gap, so a clock that is badly wrong cannot hold the queue for ever. A record refused for a key the connection did not enroll (`attester_mismatch`) is kept the same way, since signing in again delivers it.
- 2a9b060: A refused batch that no retry can deliver no longer holds up the records behind it. When the workspace refuses every record of a batch on its own as `invalid_receipt` (HTTP 400 with `rejected`), each becomes a "rejected" delivery gap, as inside an accepted batch. Any other code is retried: a timestamp ahead of the workspace's clock is accepted once the time passes, and a key the connection did not enroll is delivered after signing in again. A 409 `id_conflict` sends records one at a time until it finds the record that conflicts, which becomes an "id_conflict" gap; the rest go in batches again. Before, the exporter sent the same batch forever and every newer record waited. Every other refusal is retried with backoff, as before. A workspace that answers 429 or 503 with `Retry-After` is not asked again sooner (at most an hour).
- 6c3b253: A Cloud delivery queue that cannot be set up (a full disk, a read-only file) closes its database handle before it reports the error, instead of leaving it open.

## 0.13.0

### Minor Changes

- 433c8df: Warn mode. A workspace can set a rule to "Block, user may override": the hook then blocks a matching action until the person at the computer allows it once, with a reason, in the Scopebond Agent's window, or, where the workspace allows it and Claude Code's permission mode really asks the person, offers Claude Code's own prompt. Scopebond's own protection, rules on Block and the kill switch are never overridable; the workspace's daily limit and repeat window hold. The gateway takes an optional override handler on `handleAction` and signs an `override` record (rule, method, state, reason digest) into an approved receipt; `validateOverrideRecord` and the receipt schema define its exact shape.

### Patch Changes

- Updated dependencies [433c8df]
  - @scopebond/policy-schema@0.6.0
  - @scopebond/verify@0.4.3

## 0.12.0

### Minor Changes

- 3308250: `status --json` prints the delivery and identity status in one machine-readable shape (`scopebond.status.v1`): `state` (`delivering`, `recording_locally` or `not_governing`), the last delivery and its error code, records waiting and the age of the oldest, delivery gaps by reason, this computer's installation, generation, key and credential expiry, and which configurations exist. The desktop agent and support read this, not the human text.

  A record the workspace refuses on its own (the rest of the batch stored) now leaves the delivery queue as a `rejected` gap instead of being retried with every batch, so one bad record can never hold up the ones behind it; it stays in the local log. The SQLite outbox gains `recordGap` and `gapsByReason`.

  A delivery conformance suite runs the real runtime and queue against a workspace that refuses the connection, fails with 5xx, stays unreachable for eight days, and refuses single records: in every case each record is delivered or accounted for.

## 0.11.0

### Minor Changes

- 6e61a3b: When the workspace refuses an upload and says why, the exporter keeps its refusal code and remediation after the unchanged `ingest failed: HTTP <status>` prefix, for example `ingest failed: HTTP 401 (credential_refused): Sign it in again ...`. A refusal without a JSON body reads as before.

## 0.10.0

### Minor Changes

- 1b8be99: Reconnecting a computer always works now. When the workspace refuses this computer's countersigning key because the computer was replaced or disconnected there, `login` and `connect` replace the key and enroll again with the same, unspent token. The old key is kept in `retired-keys/`. Queued receipts signed by the earlier key leave the delivery queue as `rekeyed` gaps, so they no longer hold up newer receipts, and they stay in the local log.

  New `recover` command: it finds the local records an earlier key signed, asks the workspace to accept them, waits while an owner or admin approves it there, then sends them in bounded batches and reports how many were recovered, already present or refused. Nothing is re-signed.

  `login` and `connect` run from a folder without its own project setup now repair the connection the hook actually uses, usually the user-level one, instead of creating a second, project-level setup beside it. `--project` sets up the current folder explicitly.

  Gateway changes: enrollment refusals are a `CloudEnrollmentError` that carries the HTTP status and the workspace's code. `SqliteReceiptStore.page()` walks a large log without loading it into memory. `SqliteCloudOutbox.discardNotSignedBy()` sets aside queued receipts signed by another key.

## 0.9.0

### Minor Changes

- b65261d: Dispatch boundary. A new `dispatchGuard` on `createGateway`, and `createDispatchGuard` / `DispatchStore` in `@scopebond/gateway/node`, decide three things atomically in one SQLite transaction immediately before an allowed action is dispatched: single-use approvals (bound to actor, action type, target, policy digest, the canonical hash of the actual request and a five-minute expiry), delegated child scope (a subset of its parent, never outliving it, with cascading revocation checked on every action) and per-agent action budgets (a persistent count of dispatched parent actions per window, monitor or enforce). A denial dispatches nothing and spends nothing; an unreadable counter, an unacknowledged or expired enforce policy, or a system clock set backwards never grants unlimited dispatch. A `shared_gateway` budget is refused by independent installations. The gateway's existing signed-approval path is unchanged and now has replay, changed-action, expiry and wrong-agent tests that assert the upstream is never invoked.
- b08c8df: Align the dispatch boundary with the workspace. Scope entries use a closed kind vocabulary (`action`, `privilege`; `scopeEntryDigest` throws on another) and `actionScopeEntry(action_type, target | null)` builds the exact and any-target entries over the opaque target id, refusing an invalid type or target. A delegation check sends the action and target id and uses the workspace's `covers` answer when it gives one. A required approval with no reference in the inbox is looked up with `GET /v1/monitoring/approvals/active` and consumed as before. New: `dispatchApprovalBinding`, `openApprovalBinder`, `SCOPE_ENTRY_KINDS`, `actionScopeEntry`, `CLOUD_ACTIVE_APPROVAL_PATH`.
- 7c6fa19: Workspace source for the dispatch boundary. A guard given a `cloud` source (created by `createCloudDispatchSource`, opened automatically by `openDispatchGuard` when `cloud.json` grants `observations:write`) consumes a person's workspace approval at dispatch with `POST /v1/monitoring/approvals/consume` (strict body, closed refusal reasons; anything but a 200 is not approved), after checking that nothing else would refuse the action so a refusal for another reason does not spend the approval. The local signed-file path is unchanged and is tried first; when it holds no valid approval and the workspace cannot be reached an enforced action is denied (`approval_unavailable`). Delegated sessions the local store does not know are resolved from `GET /v1/monitoring/delegations?session_id=`, cached for 15 seconds (an active grant only), and any state other than an active, covering, unexpired grant, or an answer whose scope digest does not bind its entries, grants nothing. New exports: `delegationScopeDigest`, `scopeEntryDigest`, `privilegeScopeEntry`, `actionScopeEntries` (pinned by literal vectors), `createCloudDispatchSource`, `openCloudSource`, `targetIdFor`. Targets are sent to the workspace only as keyed opaque ids.

### Patch Changes

- Updated dependencies [b08c8df]
- Updated dependencies [aac4f6f]
  - @scopebond/policy-schema@0.5.0
  - @scopebond/verify@0.4.2

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
