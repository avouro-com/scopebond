---
"@scopebond/agent": patch
---

The updated agent now starts after a self-update on Windows. The autostart launcher redirected the agent's output into `agent.log`; the replacement launcher's own redirect then failed on the file the old agent still held, cmd skipped the command and took that for a clean stop, and the computer stayed without an agent until the next sign-in. The agent now writes its log itself, the launcher counts a command that never ran as a failure, and the handover uses the launcher's own start command. An agent running under a launcher from 0.4.6 or earlier starts its update directly, and the update rewrites the launcher. Under systemd the service restarts the agent instead of a detached child that would be stopped with it. `check` waits for the updated agent and says which version runs.
