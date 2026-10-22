---
"@scopebond/hook": minor
---

The hook can hold signed artifacts for its plugin slot: it reports `signed_artifacts_1` on the rules check, fetches each artifact the workspace's signed pack list names, keeps it only when its digest and Ed25519 signature check out, and hands the bytes, unread, to an installed plugin that reads that kind.
