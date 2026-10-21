---
"@scopebond/hook": patch
"@scopebond/agent": patch
"@scopebond/gateway": patch
"@scopebond/policy-schema": patch
---

A workspace may now ask for no reason to unblock an action or to ask an admin (`reason_min` 0, accepted by a hook that reports the `optional_reason` capability); an unblock with no reason is recorded with no reason digest and a reason length of 0, while a workspace minimum above 0 still requires a reason as before.
The Scopebond window and the tray's form accept an answer with no reason where the workspace asks for none, and say a reason is optional.
An override record with no reason (no digest, length 0) is now a valid receipt member.
The receipt schema allows an override record with no reason: `reason_digest` null and `reason_length` 0.
