---
"@scopebond/hook": minor
---

A connected computer now renews its machine credential by itself. Credentials last 90 days; in the last 30 the hook renews it during its rules check, proving it still holds the signing key it enrolled with, and saves the new credential in `cloud.json`. A computer no longer stops delivering on day 90 because nobody signed it in again. An outage or refusal leaves the saved connection unchanged, and the next check tries again.

The rules check also tells the workspace how many records wait to send, since when, and the last delivery problem (`x-scopebond-pending`, `x-scopebond-oldest-pending-at`, `x-scopebond-last-error`), so the portal can show a computer that checks in but is not delivering. It sends counts and one error line, never a record.
