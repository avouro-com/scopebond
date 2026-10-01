---
"@scopebond/hook": minor
---

Rules set by your workspace. A connected computer keeps its own rules until someone who manages the workspace changes one; it then checks for changes at most every five minutes, alongside a tool call's record delivery and capped at about one and a half seconds, installs a newer version only after checking that it is complete, issued for this computer, matches its digest and loads, and confirms exactly which version it loaded. Each rule is blocked or only recorded as the workspace chooses, and the workspace can add entries to the computer's lists; it cannot relax the protection of Scopebond's own settings and the agents' hook settings. `rules` edits and `policy load` are refused while the workspace sets the rules; a revoked connection, or a workspace that stops setting them, restores the computer's own rules. New: `policy sync`, a `rules` line in `status`, and `SCOPEBOND_POLICY_SYNC=off`.
