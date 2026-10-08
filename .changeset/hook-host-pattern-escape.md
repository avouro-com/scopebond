---
"@scopebond/hook": patch
---

Workspace allowed-site patterns escape every regular-expression character in a host name, not only the dots. The document check already admits only letters, digits, hyphens and dots, so no current policy changes; the pattern now stays literal even if that check ever widens.
