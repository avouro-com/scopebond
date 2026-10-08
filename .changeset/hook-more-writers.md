---
"@scopebond/hook": patch
---

More commands are read as writing the file they name: `certutil -decode`/`-urlcache … OUT`, `expand SRC DST`,
`bitsadmin /transfer … DST`, `git clone URL DIR` and `split FILE PREFIX`. A write whose target is only known at run time
(`> "$P"`, `tee $(…)`, a clone into the repository's own name) is also recorded as a write the hook cannot judge, so strict
mode refuses it and normal mode records it, instead of treating it as an ordinary write.
