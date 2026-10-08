---
"@scopebond/hook": patch
---

A computer whose workspace has not named an evidence detail now sends the Standard detail by default: notable receipts in
full, routine ones as one signed summary per five minutes. Full detail (every receipt sent) is used only when the workspace
says "full" on a rules check, or when this computer's own saved setting is "full". An unknown saved value is read as
Standard, never as Full. Every receipt is still kept on the computer for the retention the workspace set.
