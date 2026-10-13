---
"@scopebond/hook": minor
---

Session budgets. A workspace may limit what one coding-agent session may do (for example an overnight run: at most 50
file writes, no pushes, no package installs, for two hours), set by an admin or approved from an "Ask an admin" request.
The hook reads `session_budgets` from the rules document, counts each tool call once per limit and per session before it
runs (a retry is not counted twice; a call a rule denies gives its count back), and denies a call beyond a limit, or once
starting another coding agent in a session with an enforce budget, with the reason "session budget". Package installs
in shell commands count as `package.install`; calls counted per tool call; a budget ends at its expiry and the rules alone
decide again; Cursor's after-edit events are counted, never refused; `count_shell_as_write` (off by default) counts other
shell commands as file writes. Receipts it counted or refused carry `payload.budget`.
The counts live in `session-budgets.json` in the hook's folder (bounded, written atomically under a lock); when they
cannot be read or written for a budgeted session, the limited actions are denied. A malformed list refuses the rules
document. Allowances may now be scoped to one session (`scope: "session"`, `session_id`); older hooks ignore them. The
rules check says `x-scopebond-hook-capabilities: allowances,session_budgets`.
