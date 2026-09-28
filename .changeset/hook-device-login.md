---
"@scopebond/hook": minor
---

`login <workspace-url>` connects this computer to a Scopebond Cloud workspace without pasting anything. It asks the workspace for a short code, prints it with the page to open, and waits while someone who manages the workspace approves it for an environment and agent; the approval hands back a single-use enrollment that completes exactly as `connect` does (the same agent wiring, `--cursor`, `--codex`, `--no-install`). `slow_down`, denial and expiry are handled; the device code is kept in memory and never printed or written. `connect` is unchanged.
