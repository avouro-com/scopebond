---
"@scopebond/hook": patch
---

Self-protection now covers the Scopebond Agent and re-pointing the computer. A coding agent running `scopebond-agent autostart off`, stopping the agent by name (`pkill -f scopebond-agent`, `taskkill`, `wmic … terminate`), a global uninstall of `@scopebond/agent` or `@scopebond/hook` (`npm`/`npm.cmd uninstall -g`, `pnpm rm -g`, `yarn global remove`, `bun remove -g`), or the hook's own `login` is denied like `uninstall` and `connect`. `scopebond-agent status`, `flush`, `check`, `repair` and `autostart on` stay allowed, and a person can still run any of these from their own terminal.
