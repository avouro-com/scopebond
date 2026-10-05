---
"@scopebond/gateway": patch
"@scopebond/hook": patch
---

A record the workspace refuses only because this computer's clock is ahead of its own (`future_timestamp`) stays in the queue and is sent again, since it is accepted once the time passes; the records around it still deliver. Before, it was settled as a lost record when it shared a batch with others. After a day it is settled as a gap, so a clock that is badly wrong cannot hold the queue for ever. A record refused for a key the connection did not enroll (`attester_mismatch`) is kept the same way, since signing in again delivers it.
