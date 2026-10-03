---
"@scopebond/hook": minor
---

Workspace rules can name exact targets a rule skips: paths for the secret-read and CI-configuration rules (an exact path, or a folder ending in `/**`) and branches for the push rule. An exclusion matches exactly, same case, so it is never broader than what was typed, and an exclusion that would touch the always-on protection of Scopebond's own settings or the agents' hook settings is dropped when the policy is compiled. The rules fetch now sends the hook's version (`x-scopebond-hook-version`), so a workspace can send these lists only to computers that understand them; earlier hook versions refuse a document that carries them.
