---
"@scopebond/gateway": minor
"@scopebond/hook": patch
"@scopebond/framework": patch
---

The shell secret scanner has one copy. `@scopebond/gateway` exports `scrubShellSecrets`, `pipedSecrets`, `maskWords`, `isCredentialName` and the `PipedSecret` type, and the hook's command scrubber and mapper import them instead of keeping an identical file. The gateway's standalone server and `@scopebond/framework` are labelled preview in their READMEs. Internal tracker ids are removed from package source comments.
