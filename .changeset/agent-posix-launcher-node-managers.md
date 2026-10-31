---
"@scopebond/agent": patch
---

On macOS and Linux, the npm install's autostart launcher finds Node where fnm, Volta, mise and asdf keep their default, besides nvm and Homebrew, when the Node it was set up with is gone. When it finds none it writes a line saying so to the agent's log and exits 1, and the LaunchAgent now waits 30 seconds before launchd tries again (it was 10). An older launcher is rewritten when the agent starts.
