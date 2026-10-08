---
"@scopebond/agent": minor
---

The signed Windows install updates itself only with an installer it has checked three ways: the release manifest is signed with the updater key (an Ed25519 key separate from the Authenticode certificate; its public half is built into the program), the installer's SHA-256 and size match the manifest, and its Authenticode signature is valid and names Avouro LLC. Otherwise nothing is installed and the agent says the update could not be verified. An install for every user (Program Files) never updates itself. npm installs are unchanged.
