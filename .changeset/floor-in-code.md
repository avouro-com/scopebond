---
"@scopebond/hook": patch
---

Harden the always-on self-protection so it no longer depends on the policy file. The
floor is now re-applied in code every time the hook loads its rules, so a rules file
with the protection clauses removed or weakened still blocks reading and writing
Scopebond's own files and the coding tools' hook settings.

This also closes several ways an action could slip past the floor:

- An archive extraction or patch whose targets the command does not name (`tar -x`,
  `unzip`, `patch`, `git apply`) is now blocked when it runs in your home folder, or in
  or next to a protected folder (Scopebond's own folder, `~/.claude`, `~/.cursor`,
  `~/.codex`). In ordinary project folders it behaves as before.
- A program built at run time — a shell function or brace list used as the command
  word, PowerShell string building, aliases, `Start-Process`, or a .NET file call — is
  blocked when it could reach a protected file.
- A glob that could match any file inside a protected folder is blocked, not only the
  file names the matcher happened to know.
- A read or write through a symbolic link or junction is judged by where it really
  leads.
- The hook and agent installed globally with npm are protected like the signed
  installer's program folder.
