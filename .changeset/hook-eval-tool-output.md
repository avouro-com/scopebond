---
"@scopebond/hook": patch
---

Running a tool's output as shell code (`eval "$(fnm env)"`, `eval "$(pyenv init -)"`, `source <(kubectl completion zsh)`) is no longer blocked by safe-shell. When the command whose output runs is one plain command, read to its end, that does not print text the command line, a file or the network decides, its output is judged as running that command is, and the record names whose output ran. Output from `echo`, `printf`, `cat`, `sed`, `curl`, `git`, a decoder, inline code (`python3 -c`), a variable or anything piped in is still denied, and `source` or `.` of such a process substitution is now denied too.
