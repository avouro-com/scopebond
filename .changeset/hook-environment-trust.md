---
"@scopebond/hook": minor
"@scopebond/agent": patch
---

The hook now trusts less of the environment it runs in.

- The signed installer's hook reads `SCOPEBOND_HOME`, `SCOPEBOND_POLICY_KEYS_JSON`, `SCOPEBOND_PACK_ENGINE_LEVEL` and the `SCOPEBOND_POLICY_SYNC` settings only from its own hook command (`--setting NAME=VALUE`), never from environment variables, so a variable set for later sessions cannot move its folder or add a key it trusts. npm installs keep reading them from the environment.
- While `NODE_OPTIONS` or `NODE_PATH` is set, a hook call blocks the action and says why, because both can load other code into the program that decides. `doctor`, `status` and the other commands still run, and `doctor` names the variable.
- Scopebond's own folder is found from your operating system account's home folder, not from `HOME` or `USERPROFILE`. When they differ, the account's folder is used and `doctor` says so.
- Setting any of these variables when starting a coding agent, or for every later session, now counts as switching Scopebond off.
- When `SCOPEBOND_HOOK_DIR` names a trusted project, allowances and workspace rules documents in that project are no longer used to let a blocked action through; those come from your own Scopebond folder.
