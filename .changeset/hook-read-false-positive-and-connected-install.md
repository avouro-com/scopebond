---
"@scopebond/hook": patch
---

Fewer false blocks, and `install` respects an existing connection.

- A search such as `grep -o "scopebond[^\"]*" settings.json` is no longer blocked as switching Scopebond off. The hook also reads every command the way Windows would, where `\"` leaves a quote open. In that reading, an unreadable command now counts as touching Scopebond only when it names Scopebond's folder, a package or one of its programs. A real write or uninstall behind an unbalanced quote is still blocked.
- For programs whose options the hook knows (grep, rg, sort and others), only their declared options take a value. `grep -o PATTERN file` is now a read of `file`, not a write to `PATTERN`. A search pattern starting with `@` is no longer taken for a file.
- `install` on a computer already connected says so ("connected to <workspace> (kept)"), says the rules are set by the workspace when they are, and no longer asks to sign up or log in again. When the Scopebond Agent already runs, it says so instead of suggesting to install it.
