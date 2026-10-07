---
"@scopebond/hook": patch
---

Less noise in `status` and `doctor`. Run from the user's home folder, they no longer report the user-level Scopebond folder as
an untrusted project setup. A hook call whose bounded delivery was cut off is no longer shown as the last problem while records
reach the workspace (often through the Scopebond Agent): it is kept as history (`last_timeout_at`), and becomes the last problem
only when nothing has been delivered for 15 minutes.
