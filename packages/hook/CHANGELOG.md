# @scopebond/hook

## 0.2.0

### Minor Changes

- 4b8dab1: Add Cloud connect + auto-export to `@scopebond/hook` (connector session C). A connected hook mirrors every signed receipt to a Scopebond workspace so activity appears in the hosted portal, with no change to the local decision.

  - `scopebond-hook connect <workspace-url> <enrollment-bundle.json>` enrolls the machine's countersigning key with the workspace using the portal's one-use handoff (reusing the gateway's `completeCloudEnrollment`), scaffolds the machine if needed, and stores a scoped machine credential in `.scopebond/cloud.json` (ignored from git).
  - When connected, `createHookRuntime` wraps its receipt store with the gateway's durable Cloud exporter (`SqliteCloudOutbox` + `createCloudExporter`): delivery is best-effort and never blocks a tool call, receipts are retained locally and retried if the workspace is unreachable, and a short bounded flush keeps the hot path fast (`SCOPEBOND_HOOK_FLUSH_MS`, default 800 ms).
  - `scopebond-hook flush` delivers anything still queued — run it on a session-end hook for zero per-call latency.
  - `scaffold` now also writes `.scopebond/.gitignore` so keys, the Cloud credential and the local log are never committed. New exports: `connectCloud`, `loadConnection`, `attachExporter`, `flushBounded`, `connectionPath`, `HookConnection`.

- 4c43cdf: Add `@scopebond/hook` — the Claude Code and Cursor connector (a leaf package; no vendor SDKs). It maps each coding-agent tool call to a normalized Action Taxonomy action, checks it against policy in-path via a local check-only (M0) gateway before it runs, and records a signed receipt on the machine.

  - `scopebond-hook claude` / `scopebond-hook cursor` read a hook payload on stdin and return a deny (Claude: exit code 2) or an allow; unknown tools are recorded as not evaluated and grant nothing; any failure fails closed to deny with a repair message.
  - `scopebond-hook init [--cursor]` scaffolds a machine signing key, a countersigning key and a starter "protect main and production paths" policy, and prints the harness configuration.
  - Data minimization: file contents are never stored, shell commands are reduced to a scrubbed head plus a digest, and common secret shapes are removed before signing.
  - The pure mapper (`mapClaudeToolUse`, `mapCursorEvent`) and the `createHookRuntime` runtime are exported. Cloud export and the coverage-gap report are intentionally out of this initial release.

- 67bd0a9: Add an opt-in **strict mode** to the hook. By default an unmapped tool (one with no Action Taxonomy mapping) is observed and recorded `not_evaluated`, matching the connector conformance vector. With `strict` (`--strict` or `SCOPEBOND_HOOK_STRICT=1`, or `createHookRuntime({ strict: true })`), an unmapped tool is instead policy-checked and denied by a closed allowlist — fail-closed coverage for tools the taxonomy does not yet map, for security-conscious deployments.

### Patch Changes

- Updated dependencies [ed6a822]
- Updated dependencies [27be98a]
- Updated dependencies [973507f]
- Updated dependencies [6417866]
- Updated dependencies [8ad0aab]
- Updated dependencies [0cb916f]
- Updated dependencies [c17c1fb]
- Updated dependencies [1fd3470]
- Updated dependencies [1260a51]
  - @scopebond/policy-schema@0.3.0
  - @scopebond/gateway@0.5.0
  - @scopebond/sdk@0.1.1
