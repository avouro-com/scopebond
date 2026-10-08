---
"@scopebond/agent": patch
---

A backlog is no longer hidden after the agent restarts. Waiting used to be counted from the agent's start, so after an
update or a crash a four-hour backlog showed "Protected" for fifteen minutes. The agent now keeps the computer's wake time
in `agent-awake.json` across its own restarts; after the computer was switched off it counts from the computer's start,
and time asleep still never counts.
