---
"@scopebond/policy-schema": patch
---

Canonicalization refuses malformed (lone-surrogate) strings instead of silently escaping them.

`canonical()` serialized string values and object keys with `JSON.stringify`, which turns a lone UTF-16 surrogate into a `\udXXX` escape rather than rejecting it. RFC 8785 canonicalizes valid Unicode, and everything `canonical()` produces is signed — so a malformed string could enter a signature in a coerced form. It now throws `TypeError` on a lone surrogate (a high surrogate not followed by a low one, or an unpaired low surrogate) in any string value or key, consistent with how it already rejects non-finite numbers, sparse arrays and `undefined`. Valid surrogate pairs (astral characters) and ordinary non-ASCII text are unaffected.
