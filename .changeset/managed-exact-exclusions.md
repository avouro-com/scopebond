---
"@scopebond/hook": minor
---

Workspace rules can name exact targets a rule skips: paths for the secret-read and CI-configuration rules (an exact path, or a folder ending in `/**`) and branches for the push rule. An exclusion matches exactly, same case, so it is never broader than what was typed, and an exclusion that would touch the always-on protection of Scopebond's own settings or the agents' hook settings is dropped when the policy is compiled. The rules fetch now sends the hook's version (`x-scopebond-hook-version`), so a workspace can send these lists only to computers that understand them; earlier hook versions refuse a document that carries them.

A document with the same version as the one in force but different rules is now accepted (the workspace can change what reaches a computer without a new version, for example when an agent moves to another team); an older version, or the same rules again, is still refused. An exclusion can never reach Scopebond's own settings or the agents' hook settings or climb out of its folder (no "." or ".." segments), a branch exclusion is one exact name starting with a letter or digit, and skipping ordinary pushes to a branch keeps its force-push, deletion and mirror protection.
