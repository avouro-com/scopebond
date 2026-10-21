---
"@scopebond/policy-schema": patch
"@scopebond/gateway": patch
"@scopebond/hook": patch
---

Receipts may now carry two optional members a signed plugin gave the action: `pattern_id` (64 lowercase hex) and `intel`, an opaque slot of padded base64 holding at most 4 KiB. The receipt schema, `isReceiptIntel`/`isReceiptPatternId` and the `receipt_intel` vectors describe their shape only; the gateway signs them through the new `intel` option of `handleAction` and `observeAction`, `validateReceiptIntel` checks them, and a receipt made without them is unchanged byte for byte.

The hook can now load one optional signed plugin from `<home>/intel/current/intel.mjs`: only when the manifest beside it (`{ version, sha256, signature, key_id }`) verifies against a pinned policy key over `scopebond:component/intel/v1` and the module's SHA-256. It is asked about each action within 2 ms (a throw, a promise, a late or malformed answer gives nothing) and its answer is signed into the receipt as `pattern_id` and `intel`; it never changes a decision, and without it the hook writes exactly the receipts it wrote before.
