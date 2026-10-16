---
"@scopebond/verify": patch
"@scopebond/hook": patch
---

`checkChainHeads` judges a rollback by the order this computer received its heads, not only by the issue times the workspace signs. Kept heads without this computer's delivery times were compared by `issued_at` alone, so a workspace that rolled its chain back and stamped the lower head at or before the higher one it had already handed out passed the check, and `scopebond verify --anchor` reported that the chain heads agree. A kept head listed after a higher one is now reported as going back, whatever either says about its issue time, unless this computer's own times show the two deliveries may have been out together. Kept heads must be passed in the order received, as the chain-heads store keeps them.
