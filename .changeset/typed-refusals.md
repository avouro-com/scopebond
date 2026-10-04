---
"@scopebond/gateway": minor
---

When the workspace refuses an upload and says why, the exporter keeps its refusal code and remediation after the unchanged `ingest failed: HTTP <status>` prefix, for example `ingest failed: HTTP 401 (credential_refused): Sign it in again ...`. A refusal without a JSON body reads as before.
