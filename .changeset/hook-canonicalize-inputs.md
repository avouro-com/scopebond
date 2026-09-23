---
"@scopebond/hook": minor
---

Security: canonicalize shell and path inputs before policy evaluation, and stop a project policy from overriding the user's.

- A project `.scopebond/policy.json` no longer overrides an existing user-level install unless the user trusted that exact policy (`scopebond trust`, or `init` in the project). A later edit un-trusts it, so neither a cloned repository nor the governed agent can swap in a weaker policy.
- Every `git push` destination is checked in any spelling: `refs/heads/main`, `HEAD:main`, a second refspec, `-o`/`--repo` options, combined `-uf` flags, `--all` and `--mirror`.
- Files read or written through the shell reach the same guards as the Read and Write tools: copies and moves (`cp`, `mv`, `rsync`, `scp`, `tar`, `Copy-Item`), writers (`tee`, `touch`, `sed -i`, `Set-Content`), upload flags (`curl -T`, `-d @file`), redirections written without spaces (`x>file`), a directory reached with `cd`, and globs, variables or brace lists that could name a protected file.
- Paths and program names are matched case-insensitively; `.exe` suffixes, Windows backslash paths, PowerShell backtick escapes, `::$DATA` streams and trailing dots are normalized. `cmd /c`, `pwsh -Command`/`-EncodedCommand`, `find -exec`, `busybox`, `timeout` and `doas` are decomposed.
- The starter policy now also protects SSH private keys, cloud/registry/git credentials, key containers (`*.pem`, `*.p12`, `*.pfx`), `.envrc`, `.git/config` and Husky hooks, and denies `shred`, `truncate`, `unlink`, `wipe`, `diskpart` and `Clear-Content`. Starter policies written by earlier versions are upgraded in memory.
- `init` and `install` refuse to overwrite an agent settings file that is not valid JSON instead of replacing it.
- The Claude Code plugin pins the current hook version.
