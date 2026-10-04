---
"@scopebond/hook": minor
---

A connected computer sends its records to the address its workspace names at enrollment. When the enrollment answer carries `ingest_url` (a workspace's regional ingest address), the hook keeps it in `cloud.json` and uses it for record delivery, observations, proof receipts, `flush` and `recover`; sign-in, rules and the portal still use the workspace URL. Only an HTTPS origin without credentials is accepted (or `http://localhost` for development); anything else is ignored and the workspace URL is used, as are connections made before this version.
