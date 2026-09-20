---
"@scopebond/hook": patch
---

Fix the secret scrubber, which leaked credentials into receipts. For single-token
secret shapes (GitHub, GitLab, npm, Slack, Stripe, OpenAI/Anthropic, Google and AWS
keys, JWTs and high-entropy blobs) the replace callback treated the match offset as a
capture group and emitted the secret followed by `***` instead of masking it — the
un-redacted value was then signed into the receipt, written to the local store and
exported to Cloud. The scrubber is rewritten as explicit `pattern → replacement`
rules covering private-key blocks, credential flags and headers, URL userinfo,
credential-named `NAME=value` assignments and the token families above. Structured
mapper parameters (program, git-push remote and ref, fetch host and path) are scrubbed
too, so a secret embedded in a command can no longer survive as a path-split fragment,
while ordinary policy-matched values (branch names, remotes, commit ids) are left
intact. Adds a property-based regression suite that asserts no secret fragment reaches
the signed receipt, the on-disk store or the Cloud export.
