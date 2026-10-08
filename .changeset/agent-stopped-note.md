---
"@scopebond/agent": patch
---

A stop asked for by this computer's user (`scopebond-agent stop`) leaves `agent-stopped.json` in the Scopebond folder,
and the next start of the agent removes it. The native Windows tray uses it to tell a stop on purpose (it leaves the
agent stopped) from an agent that went away without a replacement (it starts it again).
