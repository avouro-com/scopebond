---
"@scopebond/hook": minor
"@scopebond/policy-schema": minor
"@scopebond/gateway": patch
---

Safe Install: before a detected install runs, a hook connected to a workspace that offers the check asks it for a verdict (block, ask or allow, with reason codes and plain words) within the hook's deadline. A block denies with what was blocked and why; an ask uses the coding agent's own prompt (Claude Code in a mode that prompts, Cursor, GitHub Copilot) or, where the agent cannot ask, denies with how to go ahead; an allow goes on to the rules. Offline or late, the signed block list kept on the computer blocks what it names, earlier answers and a 7-day age gate apply, and anything else is asked about. The verdict, its reason codes and where it came from are signed into the install's receipt (`software.install` gains the optional `verdict`, `verdict_reasons` and `verdict_source` parameters). The gateway's dispatch reasons gain `install_refused`.
