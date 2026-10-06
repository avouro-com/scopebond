---
"@scopebond/hook": minor
---

`status` and `doctor` say when this computer needs attention to keep delivering and stay up to date, each with the one command that fixes it. When the workspace recommends a newer Scopebond than the one running (it says so on every rules check), they print the update command. They also say whether the Scopebond Agent runs: running, installed but not running (start it with `scopebond-agent autostart on`), or not installed (with its setup command). Only an agent that is installed but not running fails `doctor`; an older version or a computer without the optional agent is shown, not failed on.
