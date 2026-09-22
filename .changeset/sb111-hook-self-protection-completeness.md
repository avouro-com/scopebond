---
"@scopebond/hook": minor
---

Self-protection completeness and a runnable first run (security).

The starter policy protected the hook's own keys and config only against the
native file tools. Three gaps let a governed agent reach them anyway; all are now
closed, with regression cases in the mapper suite and the bypass corpus:

- **Shell reads of the signing key or a secret file** (`cat .scopebond/attester.key`,
  `head .env`) mapped to `shell.exec` only, bypassing the `file.read` guard entirely.
  A reader program's operands (and the targets of `>`/`>>` redirections) now also
  emit `file.read`/`file.write` intents, so the same `protect-read`/`protect-write`
  clauses apply. Reading the attester key — which would let an agent forge receipts —
  is denied.
- **Windows backslash paths** (`.scopebond\policy.json`) did not match the guard
  patterns, which are written with `/`. Paths are normalized to `/` before matching.
- **The `PowerShell` and generic `Shell` tools were unmapped**, so a command like
  `Remove-Item -Recurse -Force .` fell through to an un-evaluated `tool.<name>` and
  was allowed. They now decompose like `Bash`, and the starter policy's destructive
  denylist covers the Windows/PowerShell forms (`del`, `rd`, `rmdir`, `erase`,
  `deltree`, `format`, `Remove-Item`).

Also: `init` now prints runnable `npx -y @scopebond/hook@<version> …` commands for
the follow-up steps (the previous `scopebond-hook …` form is not on PATH after an
`npx` install), and `engines` requires Node `>=22.13` (the cloud outbox needs
`node:sqlite`, which is unavailable/flagged on 22.0–22.12).

Existing scaffolded policies are unchanged — only newly-initialized policies pick up
the tighter destructive denylist; the mapper-level protections apply to every install.
