---
"@scopebond/hook": patch
---

`login` on a computer with nothing set up yet connects the user's home, not the folder the terminal happened to open in. A first login from an editor's terminal used to connect the project folder, so the hook, which reads the user home everywhere else, found no connection and delivered nothing. `--project` still connects the folder.
