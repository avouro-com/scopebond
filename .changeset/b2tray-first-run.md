---
"@scopebond/agent": patch
---

The tray model now gives the code of a sign-in waiting for approval (`sign_in_code`, and the tooltip "Scopebond: approve code ABCD-EFGH" with the code whole), says whether this computer's first sign-in is still to come (`first_sign_in`), and names the update this computer took for a day after it (`updated`, from the new `noteRunningVersion`, which remembers the version that last ran in the Scopebond folder).

The Windows tray restarts an agent that crashed, hung or stopped without a word, and tells the person only when two restarts in a row fail within ten minutes ("Protection is off on this computer" with a Restart it button, which starts the agent at once).
