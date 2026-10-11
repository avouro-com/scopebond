---
"@scopebond/hook": minor
---

Windows signed-installer parity. Under the single executable (`scopebond-agent.exe`, which is also the hook), every command the hook prints for a person (a blocked action's message, `status`, `doctor`, help, next steps, sign-in retries) is `scopebond-agent hook <command>` or `scopebond-agent <command>`, never `npx.cmd`/`npm.cmd`; npm installs keep the version-pinned npx form. `cliCommand(sub, platform, native)` and `agentCommand(sub, platform, native)` are the one place this is decided.

- `init --shared` still writes the portable npx form to the shared file; run from the installer on a computer without npx, it also covers that computer (a user-level hook that starts there, else Claude Code's `settings.local.json`, else it prints the `install` command). `connect --project` from the installer pins the installer's program for this computer instead of the npx form.
- Scopebond's always-on write protection also covers the signed installer's folder (`%LOCALAPPDATA%\Programs\Scopebond`, `%ProgramFiles%\Scopebond`, in any case and in their `%…%`, `$env:…` and short-name spellings): a coding agent may read it but not change or delete the program there. Policies compiled by earlier versions get the new pattern on load.
- `status` and `doctor` report a hook entry that names a single executable which is no longer there, with the commands that repair it.
- A read-only search whose pattern names Scopebond (`grep -rhoE "scopebond-agent(\.cmd)? (setup|status)[^\"]*" docs/`, `git grep …`, `rg`, `findstr`, `Select-String`), whose Windows or PowerShell reading leaves a quote open, is no longer taken for switching Scopebond off. A redirect, a second command, code in an argument, or Scopebond's folder in the searched files still count.
