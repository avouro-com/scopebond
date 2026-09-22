---
"@scopebond/gateway": patch
"@scopebond/hook": patch
---

Register the hook's separate agent signing key during enrollment using a challenge signed by both keys. Require the server to acknowledge that key before saving the connection, so authenticated receipts can be uploaded. Let doctor and flush exit normally after network requests to avoid a Windows shutdown assertion.
