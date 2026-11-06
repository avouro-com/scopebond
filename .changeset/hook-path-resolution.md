---
"@scopebond/hook": patch
---

Paths are judged as they resolve: a file path with `..` in it, or one that leads through a link into `.git` or `.github`, is checked as the place it names as well as as written. Code that the command line decodes and then runs (`base64 -d | sh`, `eval "$(… | base64 -d)"`, an interpreter's `-c` code that decodes and executes) is treated as a change to Scopebond's own settings, because what it does cannot be read before it runs. `~/.gitconfig` and `~/.config/git/config` join the files the always-on protection keeps, as `git config --global` already did for the keys that run code.
