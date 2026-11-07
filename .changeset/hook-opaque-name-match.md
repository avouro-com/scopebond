---
"@scopebond/hook": patch
---

A command substitution inside double quotes now keeps its own quoting, so the usual way to put a single quote inside single quotes (`'it'"'"'s'`) no longer makes a command such as `gh pr create --body "$(printf '%s\n' 'it'"'"'s')"` unreadable. A command that still cannot be read is treated as switching Scopebond off only when it names Scopebond itself (its folder, a program or package, a launchd label, an install folder, an environment variable), not when the word only appears inside the name of something else: a repository (`acme/scopebond-docs`, `acme/scopebond`), a checkout folder (`~/code/acme/scopebond`) or the website (`scopebond.com`). A Windows short name of the folder (`SCOPEB~1`) in such a command now counts too.
