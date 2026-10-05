---
"@scopebond/hook": patch
---

Security: with the workspace's secret-read rule on Monitor, reads of Scopebond's own folder (this computer's signing key and connection) were no longer stopped. That floor is now always on, as the write floor already was.
