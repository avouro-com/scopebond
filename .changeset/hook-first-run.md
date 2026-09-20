---
"@scopebond/hook": minor
---

Make the hook usable in one command and honest on first run.

- `init` now configures the agent automatically (idempotent; `--no-install` prints
  the snippet instead), and both `init` and `connect` install a **version-pinned**
  `npx -y @scopebond/hook@<version> <harness>` command rather than a bare
  `scopebond-hook`, so a missing global binary is fetched instead of silently
  skipped (which a harness can treat as "no hook" and fail open). A legacy bare
  command is replaced in place, never duplicated.
- New commands: `scopebond-hook log` (recent decisions), `scopebond-hook verify`
  (every local receipt verified offline against the attester key), and
  `scopebond-hook test "<command>"` (show a command's decision without recording
  it), so a new user reaches a visible, verifiable receipt in the first minute.
- The starter policy no longer breaks ordinary work: `net.fetch` and MCP tool calls
  are observed (recorded, not blocked) instead of denied by the closed allowlist,
  and a bare `git push` is allowed on a non-protected branch — the runtime resolves
  the current branch and fills it in (`fillPushBranch`), so only pushes to
  `main`/`master`/`release/*` are denied. If the branch can't be resolved the ref
  stays absent and the policy fails closed.
- The README leads with the hook and the 60-second flow and lists all eight
  packages; collateral vocabulary is out of the lead.
