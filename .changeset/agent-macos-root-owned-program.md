---
"@scopebond/agent": patch
"@scopebond/hook": patch
---

On macOS, the installer package puts the agent and the hook in `/Library/PrivilegedHelperTools/scopebond-agent`, a folder only root can write, with only a link to it at `/usr/local/bin/scopebond-agent` for terminals. The package's LaunchAgent, every hook entry and the menu-bar app run the program there, never the link: Homebrew on Intel gives `/usr/local/bin` to a person, and launchd runs the program as every person who signs in. Postinstall says when someone other than root could change the program, its LaunchAgent or a folder above them, and `scopebond-agent hook doctor` checks it too (`program owner`), along with where the link points (`PATH link`). The package's `uninstall.sh` now runs the agent's uninstall as every person on the Mac with a Scopebond folder, not only the person removing it (their folders stay), and an uninstall that fails for someone is named and exits 1 instead of 0.
