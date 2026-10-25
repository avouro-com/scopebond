---
"@scopebond/hook": patch
---

The always-on protection covers the shell startup files (`.zshrc`, `.bashrc`, `.profile`, `.zshenv`, fish and PowerShell profiles, `/etc/profile.d`, `environment.d`): a line the coding agent added there would run in every later session, the next agent's included. A command that sets a variable moving Scopebond's folder (`SCOPEBOND_HOME`, `SCOPEBOND_HOOK_DIR`) or a coding agent's for every later session (`setx`, `launchctl setenv`, a User or Machine `SetEnvironmentVariable`) is a switch-off, as is starting a coding agent with Scopebond's folder moved. Once a person's own install exists, a hook call honours `SCOPEBOND_HOOK_DIR` only for that install or a folder whose policy the person trusted. A policy on disk is upgraded to the new protection when it loads.
