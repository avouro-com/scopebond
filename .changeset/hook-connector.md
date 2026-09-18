---
"@scopebond/hook": minor
---

Add `@scopebond/hook` — the Claude Code and Cursor connector (a leaf package; no vendor SDKs). It maps each coding-agent tool call to a normalized Action Taxonomy action, checks it against policy in-path via a local check-only (M0) gateway before it runs, and records a signed receipt on the machine.

- `scopebond-hook claude` / `scopebond-hook cursor` read a hook payload on stdin and return a deny (Claude: exit code 2) or an allow; unknown tools are recorded as not evaluated and grant nothing; any failure fails closed to deny with a repair message.
- `scopebond-hook init [--cursor]` scaffolds a machine signing key, a countersigning key and a starter "protect main and production paths" policy, and prints the harness configuration.
- Data minimization: file contents are never stored, shell commands are reduced to a scrubbed head plus a digest, and common secret shapes are removed before signing.
- The pure mapper (`mapClaudeToolUse`, `mapCursorEvent`) and the `createHookRuntime` runtime are exported. Cloud export and the coverage-gap report are intentionally out of this initial release.
