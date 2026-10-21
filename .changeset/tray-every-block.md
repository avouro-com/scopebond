---
"@scopebond/hook": patch
"@scopebond/gateway": patch
"@scopebond/agent": patch
---

The tray lists every block of the last seven days (up to 200), not only those among the newest 5,000 records, so a busy day no longer shows a blocked count over an empty list. The local store keeps an index of denied records for this (built by the agent's upkeep on an existing store).

An agent's retries of one block (the same action, rule, project and session, each within 10 minutes) are one row with the number of tries, are announced once, and count once: the header, the Blocked tab, the menu and the Today row all show the same number of distinct blocks.

Every block carries one outcome: Unblock, Ask an admin, or a plain sentence saying why it stays blocked (Scopebond's own protection, a rule set by the workspace, Safe Install's verdict in words, or Safe Install holding an install for the person), with "Copy details" where it helps. A block the person asked about follows the request (waiting, approved by whom, declined) and offers nothing more once a request or an allowance covers it; while a request waits, the agent checks for the answer every 10 seconds for 10 minutes, and the answer is announced unless notifications are off.

"Check now" checks the rules and packs again and runs the self-check; it never installs an update. A failed self-check is kept until a check passes.

The npm tray icon's menu shows `&` in commands as it is.

The coding agent trying a blocked action again within 10 minutes, before the person answered, is not asked about again: the denial tells the agent not to retry and to tell the person, who acts on it from the tray.
