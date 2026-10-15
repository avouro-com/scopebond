---
"@scopebond/hook": patch
"@scopebond/agent": patch
---

Every block the tray lists names its rule, and the project and coding tool where the hook knows them.

- Rule names are the workspace's own ("Rewrite history on a protected branch", "Run a command that deletes data or shuts down the computer", "Read passwords, keys or secrets", …), for every workspace rule, in the tray, the Scopebond window and the hook's messages. A block by Scopebond's own protection reads "Change Scopebond's or the agent's safety settings" (a change) or "Read passwords, keys or secrets" (a read), and a blocked service reads "Blocked service". A rule the hook cannot name reads "A Scopebond rule": never an empty line, never a rule id. `ruleName` and `blockTitle` join `ruleTitle` in the hook's exports.
- The hook notes each call it blocks in `block-notes.json` in its folder: the action's id, the clause that denied it and the rule that clause carries, the coding tool's id and the project's name (the repository's, else the folder's, never the home folder). It holds no arguments and never leaves the computer. `localActivity` reads it, so a block whose receipt has no context (a workspace that has not said it reads it) or names no rule still shows its rule, project and tool; each recent block now carries `rule_title` and `project`.
- The hook's question to the agent carries the project (`project`), for the window and the tray.
- The tray's panel and notifications show "A Scopebond rule" when an older agent sends no rule name, instead of a blank line or the rule's id.
