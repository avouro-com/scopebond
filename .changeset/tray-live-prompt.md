---
"@scopebond/hook": minor
"@scopebond/agent": minor
---

The tray answers the hook's question during a coding session, and a person can stop an allowance.

- Live prompt: when the hook asks the agent during a coding session (`POST /override`) and a tray is listening, the agent hands the question to the tray first (`POST /override/wait`, a long wait; `GET /tray` carries it as `pending`). The person answers in the tray's panel (`POST /override/answer`, checked as the window's answer would be), and the hook's waiting call receives that answer. If the person does not open the question in the tray within a third of the hook's wait (ten seconds at most; `POST /override/open` says they did), it is withdrawn and the Scopebond window opens for the time left. With no tray listening the window opens at once, as before. Unanswered at the deadline, nothing is allowed.
- The hook's question carries the coding tool and what the workspace set about the length (`harness`, `reviewed`, `always_days`, `always_needs_admin`); an older agent ignores them.
- Stop allowing: `POST /allowances/stop` ends an allowance the person made (`endAllowance` in the hook: it stops applying at once and stays stopped when the workspace sends its copy). The agent sends the workspace `{ id, state: "ended", ended_by: "person", ended_at }` to `/v1/allowances`, signed like the other records, once; a workspace that refuses it is not asked again.
- Where the workspace sets the unblock terms, an allowance a person makes carries `unblocked` (`automatic` or `person`); the Allowed list shows "Unblocked automatically".
- The Scopebond window says "Ask to unblock" ("You may ask to unblock it; an admin decides."), and the macOS and Linux dialogs offer the workspace's one length when it sets one (`singleChoice`) instead of refusing.
