---
"@scopebond/agent": patch
"@scopebond/hook": patch
---

First-run fixes on Windows and beyond. The agent's autostart launcher switches cmd.exe to UTF-8 and writes its log beside itself, so it starts in a profile folder with non-ASCII letters. Only one agent runs per home even when two start moments apart (a lock file decides). Upkeep and repair keep the hook pinned by its path (the hook the agent carries) instead of switching to the slower `npx` form, which also needed npx on the coding tool's PATH. `setup` runs the sign-in from the home folder and, when a sign-in has to be repeated, names the setup command; npm is run as this Node's own npm, without a shell. A workspace that cannot be reached is explained (a company certificate: `NODE_EXTRA_CA_CERTS`; a proxy: `NODE_USE_ENV_PROXY=1`), and `doctor`'s note says the policy it read is Windows PowerShell's. Autostart starts the launcher with `cmd /s /c ""…""`, so a profile folder whose name has a space and `(`, `)` or `&` ("John (Work)") still starts the agent. The one-agent lock is taken over when it is older than a minute and no agent answers, so a sign-in after a restart is not refused because Windows reused the old process id.
