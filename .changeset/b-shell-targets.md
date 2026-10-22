---
"@scopebond/hook": minor
---

A shell command that deletes or writes files now names its targets in its signed record (`targets`: up to 16 paths, relative inside the working folder, never file contents), so a block's digest says what kind of place it reaches (build output, temp, home, system) instead of unknown. A command whose targets are of more than one kind, or that climbs with `..`, has no single kind, and a folder named like build output or temp counts as that only inside the working folder (`~/dist` is the home folder); a workspace's quiet entry made for one kind of place never quiets another, and a shell record from an older hook, which names no targets, keeps the digest it had.
