---
"@scopebond/hook": patch
"@scopebond/gateway": patch
"@scopebond/policy-schema": patch
"@scopebond/agent": patch
---

The same action gets the same treatment in Claude Code, Codex and Cursor.

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
