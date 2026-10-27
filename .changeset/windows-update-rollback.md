---
"@scopebond/agent": minor
---

On Windows, a signed update that installs but does not start is taken back: the agent's update helper fetches and checks the previous release's installer, removes the new version without telling the workspace or touching the hook entries, installs the previous one again with the workspace it had, and checks that it answers. The failed version is still not tried again for a day.
