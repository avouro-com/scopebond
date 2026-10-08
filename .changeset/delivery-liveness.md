---
"@scopebond/gateway": patch
"@scopebond/hook": patch
"@scopebond/agent": patch
---

Delivery no longer stalls on a request that never answers. Each delivery request now has a time limit (30 seconds by default, `requestTimeoutMs`), and the limit also covers reading the answer.

The Scopebond Agent:
- caps each delivery cycle at 10 minutes and goes on to the next cycle;
- starts its maintenance before the first cycle;
- answers Send now and stop without waiting on a stuck cycle;
- reports when the running cycle started (`cycle_started_at` in `/status`).

The hook:
- waits on a flush that is already sending instead of returning at once, so a backlog of 100 or more records drains from hook calls;
- records a cut-off only when its time limit really ran out;
- no longer replaces the agent's recent delivery error with its own cut-off message.

An agent that the workspace's plan paused now says so in the tray and in `status`, instead of offering Send records now.
