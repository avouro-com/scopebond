---
"@scopebond/verify": patch
---

Add conformance vectors for the array-parameter bound's `match: "any"` mode and edge cases (at least one element must satisfy the item bound; an empty array denies under `match: "any"`; a non-string element denies a pattern bound). The behavior was already correct; these lock it in against regression.
