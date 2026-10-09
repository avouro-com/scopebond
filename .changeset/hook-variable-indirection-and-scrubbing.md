---
"@scopebond/hook": patch
---

The always-on protection now follows shell variables set earlier in the same command: `x=.claude; rm -rf $x`, `export x=…`, a `for` loop, cmd `set x=… & rd %x%` and PowerShell `$x = …; Remove-Item $x` are judged with the value the variable holds, while a variable that names a build folder, a temporary folder or another project's files stays allowed. Recorded commands keep everything after a quote that only closes an earlier string (`git commit -m "token = " --no-verify`), and a value piped into a secret reader is masked only in the command it came from. On Windows, `status` and `doctor` say when the hook's folder could not be made private and its files are restricted one by one.
