---
"@scopebond/agent": patch
"@scopebond/hook": patch
"@scopebond/gateway": patch
---

macOS client fixes.

- The package's root updater no longer stops for good when something other than a request file (a folder, a link, a pipe) is left in its requests folder: such entries are skipped and logged.
- After installing an update, the root updater waits for the new agent to run for everyone signed in. If it does not, the update is recorded as failed and the release before is installed again (the package kept from its own install, or downloaded and checked again). Every agent is started again afterwards, also when a package failed part way.
- The package installs the executable in `/Library/Application Support/Scopebond/bin`, a folder only root can change, and runs it from there (LaunchAgent, hook entries, menu-bar app). `/usr/local/bin/scopebond-agent` becomes a link for PATH only. Hook entries that name the old path are moved on upgrade, and `doctor` checks that the executable and its folders belong to root.
- Removing the package takes the hook out of the settings of every person on the Mac whose coding agents still run it, not only the person removing it.
- A hook entry whose Node a version manager (fnm, Volta, nvm, asdf, mise) has uninstalled is now reported as broken by `doctor`, the self-check and integration health, and the agent writes it again. New entries name fnm's default alias or a Node installed outside a version manager when the running Node is version-managed. The npm autostart launcher also finds Node through fnm, Volta, asdf and mise.
- The delivery queue has a size limit (512 MB by default, `SCOPEBOND_OUTBOX_MAX_MB` to change it). Past it, new receipts stay in the local log and are counted as gaps the workspace is told about. `status` and `doctor` warn when the queue is full or nearly full, and the rules check reports the backlog's size.
