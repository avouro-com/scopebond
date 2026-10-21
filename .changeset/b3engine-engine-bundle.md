---
"@scopebond/policy-schema": patch
"@scopebond/gateway": patch
---

Receipts may now carry two optional members a signed plugin gave the action: `pattern_id` (64 lowercase hex) and `intel`, an opaque slot of padded base64 holding at most 4 KiB. The receipt schema, `isReceiptIntel`/`isReceiptPatternId` and the `receipt_intel` vectors describe their shape only; the gateway signs them through the new `intel` option of `handleAction` and `observeAction`, `validateReceiptIntel` checks them, and a receipt made without them is unchanged byte for byte.
