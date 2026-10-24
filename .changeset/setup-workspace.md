---
"@scopebond/agent": minor
---

`scopebond-agent setup <url> --workspace=<id>` signs a computer in to the workspace the command was made for when it is connected to another workspace on the same address, instead of answering "already connected" (one address serves every workspace). Without `--workspace`, setup behaves as before; a malformed id is ignored.
