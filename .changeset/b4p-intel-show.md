---
"@scopebond/hook": patch
"@scopebond/gateway": patch
---

`scopebond intel show [--json] [--raw]` prints what the next upload of records to the workspace will contain: it runs the hook's own uploader against a copy of the delivery queue, without sending or changing anything, and shows a summary by category (action kinds, parameters, rule results and rules, coding tools, counts) and the request bodies, with a plugin's opaque slot shown as its size (its base64 with `--raw`) and parameters masked again; when nothing is waiting it says so and shows the fields one record carries. The hook README has a new "What leaves this computer" section.

A delivery queue can now say what claiming a summary window would answer without claiming it (`peekWindow`), so a preview of the next delivery changes nothing.
