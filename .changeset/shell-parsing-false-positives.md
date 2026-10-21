---
"@scopebond/hook": patch
---

PowerShell assignments, `foreach`/`if`/`while`/`switch` statements, script blocks and bare variable expressions are no longer blocked as commands that could not be read: the commands inside them (a `Remove-Item` in a `ForEach-Object` block included) are judged as usual, and only a program known at run time (`& $x`, `iex $cmd`, `. $x`) is still refused.

A command that only prints its help or version or rehearses (`rm --help`, `rm -h` on its own, `sudo --version`, `git push --dry-run origin main`, `--help` or a `help` subcommand of a tool a rule pack reads) is recorded and no longer refused as the deletion or push it names; `shutdown -h`, a `--help` after a file operand and an option's value are still read as before.
