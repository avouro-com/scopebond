---
"@scopebond/agent": patch
---

Records waiting to send are now the agent's job alone: the tray stays "Protected" with no "Send records now" and no attention state, the agent starts again at once when a delivery worked elsewhere or the computer woke instead of waiting out its backoff, and only after 24 hours awake and online without a delivery does Settings show "Records can't reach <workspace> since <time>"; on macOS and Linux a notification now comes only when the person must act, and when that is over.

The agent now repairs this computer's setup as soon as it sees it broken (each cycle, whenever the tray asks, and before every self-check): a Scopebond hook entry a coding agent's settings lost is put back, a second copy is taken out, and autostart that is on but broken is started again (autostart the person turned off stays off); each repair is checked again and recorded as `last_repair` in `status`, the self-check runs once more after a repair, and the tray shows only a repair that failed, as "Scopebond couldn't reconnect to Claude Code" with Repair.

Rules not checked for over an hour no longer turn the tray to "Rules not checked for…": the last-known rules stay in force, the agent checks again at once after a failed check and then after 1, 2, 4, 8 and at most 15 minutes, and Settings' "Rules updated" says when the last check worked.

A self-check that did not pass no longer turns the tray to attention: Settings shows "Last check didn't pass: …" in words (never check ids), the line stays until a check passes, and "Check now" names what it found in the same words.

A credential that ends within a week is renewed by the agent itself (at most once an hour, besides the rules check's own renewal), silently when the workspace renews it or does not answer; only when the workspace refuses does the tray ask "Sign in again to keep this computer connected" with "Sign in again…", and `status` reports the last renewal as `credential_renewal`.

An update that does not install (a failed download or check, an install or start that failed) is now tried again after 1 hour, then 6 hours, then every 24 hours while the running version keeps protecting; `failedUpdate` reports how many tries failed, a version that installs forgets them, and Settings says "Update didn't install; Scopebond keeps protecting on <version>" only from the third failed try (nothing before).

A workspace that refuses records for billing reasons (its monthly limit, no license, or the plan paused this agent) no longer turns the tray to attention for the developer: the tray stays "Protected" with no button, and Settings shows one line such as "Not licensed · 4 records wait on this computer" with the plain note under it.

A workspace that cannot be reached now keeps the tray "Offline" however long it lasts (no attention state after four hours, so no toast), with the one line "Using this computer's rules; records send when back online".

A person can mark a block "This shouldn't be blocked" from its details in the tray; the mark (the record, the rule and the action's key, never a reason or a command) is sent to a workspace that takes it, so its admins see which rules get in the way.
