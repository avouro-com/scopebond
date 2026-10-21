---
"@scopebond/hook": patch
---

An unblock now covers exactly the command the Scopebond window showed: the same command passes again in another line, after a `cd`, with a redirection such as `2>&1`, other quoting or a trailing slash, while a different target, a relative target in another folder, or another project still asks. The window shows that command, with the folder when a target is relative to it, and unblocks made before still apply.
