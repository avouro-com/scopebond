---
"@scopebond/hook": patch
---

A nested script is read in the language of the program that runs it. `pwsh`/`powershell -Command` (and a decoded `-EncodedCommand`) and `Invoke-Expression` are read as PowerShell, so a backtick escape (``Get-Content ~/.sc`opebond/agent.key``) or a string join no longer hides a protected file. `cmd /c` and `cmd /k` are read as cmd: `^` escapes are applied and `&`, `&&`, `||`, `|` separate commands; a command that expands a variable (`%NAME%`, `!NAME!`) is treated as known only at run time, so a rule that would apply to it denies. An encoded command that cannot be decoded stays opaque. Ordinary nested commands map as before.
