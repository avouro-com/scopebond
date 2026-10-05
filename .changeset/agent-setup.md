---
"@scopebond/agent": minor
---

`scopebond-agent setup <workspace-url>` (for example `npx -y @scopebond/agent@latest setup https://cloud.scopebond.com`; `npx.cmd` on Windows): one command that checks Node.js, signs the person in with a code (which puts the hook in the user-level agent settings), installs the agent for the user, turns autostart on and ends with `status`. Running it again keeps an existing connection to the same workspace, does not reinstall the same version and only repairs what is missing; `--relogin` signs in again. When npm's global folder is not on PATH it names the folder and the command that adds it.
