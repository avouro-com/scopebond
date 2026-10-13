---
"@scopebond/policy-schema": minor
---

Records now carry an optional `context` saying where they were produced, so a workspace can group them by session and
filter them by tool, model and repository. `schema/receipt.schema.json` adds `payload.context`: a closed object of
`harness`, `harness_version`, `model`, `session_id`, `repository` (the git remote `origin` as `host/owner/name`) and
`branch`, each optional and nullable. It carries no local paths, user names or prompts, and the signature covers it. A
receipt without it is unchanged; an unknown key inside it makes the receipt invalid. New: `RECEIPT_CONTEXT_KEYS`, the
`receipt_context` cases in `vectors/evidence-contract.json` and a canonicalization vector for a context member.
