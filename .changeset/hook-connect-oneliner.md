---
"@scopebond/hook": patch
---

Make `scopebond-hook connect` a true one-command setup for non-technical onboarding. The enrollment argument now accepts an inline base64 blob or raw JSON (not just a file path), so the portal can hand out a single copy-paste command with nothing to save; and `connect` now **auto-configures the agent** by merging the hook into `.claude/settings.json` (or `.cursor/hooks.json` with `--cursor`), preserving existing settings and idempotent on re-run (`--no-install` to skip). New export: `installHarness`.
