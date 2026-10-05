---
"@scopebond/agent": patch
---

`scopebond-agent autostart off` also stops the running agent, and the new `scopebond-agent stop` stops it until the next sign-in. Before, an agent turned off (or even uninstalled with `npm uninstall -g`) kept running until the person signed out, with no command to stop it.
