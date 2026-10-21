---
"@scopebond/hook": patch
---

PowerShell assignments, `foreach`/`if`/`while`/`switch` statements, script blocks and bare variable expressions are no longer blocked as commands that could not be read: the commands inside them (a `Remove-Item` in a `ForEach-Object` block included) are judged as usual, and only a program known at run time (`& $x`, `iex $cmd`, `. $x`) is still refused.
