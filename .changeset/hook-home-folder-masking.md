---
"@scopebond/hook": minor
"@scopebond/agent": patch
---

Records no longer name your account. Before an action is signed, the hook writes your home folder as `~` in the working
folder, file paths and the command line (a project in your home folder is recorded as `~/repo`), and the account name
in any other home-folder path as `~other`. The home folder is the one the system reports plus `HOME` and `USERPROFILE`;
a Windows home matches in any case and with either separator. Rules keep matching: rules written relative or with `~`
match as they are, and a rule that names your home folder by its full path is read as `~/…` when the rules load
(`rules protect <path>` now stores it that way).

New: `SCOPEBOND_HOSTNAME_MODE` chooses the computer name a sign-in sends (`login`, and the Scopebond Agent's first
sign-in): `full` (the default, unchanged), `hash` (the first 12 hex characters of the SHA-256 of the host name) or `off`
(none).
