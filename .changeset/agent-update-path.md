---
"@scopebond/agent": patch
---

The agent's own updates are harder to subvert. The npm update (and `setup`'s install) runs `npm install -g` with package
scripts off and the public registry pinned (also for the @scopebond scope), without registry or script settings from the
environment, and only after the registry's npm provenance for that exact version names this repository's main branch and
the tarball it serves. The workspace's version answer is bounded: at most 4 KiB, a known policy, strict `x.y.z` versions
no more than one major version ahead; anything else is no answer and nothing changes. Hook entries are always pinned to the
hook the agent carries, by its path: a version named by the workspace is no longer followed, the `npx -y …@<version>` form
is never written, and existing `npx` entries are re-pinned. After installing, the agent runs the new program and requires
it to report the new version, then waits for the new agent to answer before exiting; if either fails it reinstalls the
version it was running and does not retry that version for a day. The new `scopebond-agent version` command prints the
agent and hook versions. The signed Windows updater can trust several updater keys (key id and last day of use, from
`updater-keys.json`), a manifest names the key that signed it, and the helper checks the installer's size, digest and
signature again, from a handle that keeps the file unchanged, right before it starts msiexec; Windows' tools are started
by their full paths.
