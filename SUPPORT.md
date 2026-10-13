# Support

Scopebond is maintained by one person at Avouro LLC. The times below are targets,
not a contractual service level.

## Getting help

- **Questions and bugs:** open an issue in this repository. Include the package and
  version (`scopebond status --json` shows the hook's, `scopebond-agent --version` the
  agent's), your operating system, your Node.js version and the coding tool, and the
  output of `scopebond doctor`.
  Remove secrets and private paths before posting.
- **Security vulnerabilities:** never in a public issue. Follow [SECURITY.md](SECURITY.md):
  email security@scopebond.com or use GitHub's private "Report a vulnerability".
- **Scopebond Cloud** (the hosted workspace) is not in this repository; it is covered by
  its own terms. Report Cloud security issues to the same address.

## Supported versions

The hook (`@scopebond/hook`) and the agent (`@scopebond/agent`, and the signed Windows
installer built from it) are **0.x releases**. Until 1.0.0:

- only the newest published release of each is supported;
- any minor release may change behavior; the changelogs say what changed;
- fixes ship in the next release, not as backports.

From 1.0.0 they follow [Semantic Versioning](https://semver.org/), and:

| Line | Gets | For how long |
| --- | --- | --- |
| Newest minor of the current major | every fix | until the next minor |
| Previous minor of the current major | security fixes | 90 days after the next minor |
| Newest minor of the previous major | security fixes | 180 days after the next major |
| Anything older | nothing; update | — |

Breaking changes wait for a major and are deprecated at least 90 days before it, with
a release note and a warning from the tool. Breaking includes removing or renaming a
command, flag or receipt field, changing an exit code, a default that lets through an
action it used to stop, a valid policy that is refused or changes meaning, being unable
to verify a receipt an earlier 1.x release wrote, and dropping an operating system,
coding tool or Node.js line (except a Node.js line past its upstream end of life). A
security fix may change behavior in a patch when it cannot wait; its notes say so.

## Platforms

- **Node.js** 22.13 or later on a line still maintained upstream (the `engines` field).
- **Operating systems:** Windows 11, macOS (two newest major releases), Ubuntu LTS (two
  newest).
- **Coding tools:** Claude Code, Cursor, Codex and the GitHub Copilot CLI, at their
  current stable release. A tool update that changes its hook format is fixed in a patch.

Support is not the same as verified: a combination is verified only when a person has
run it end to end on the versions named. Today only Windows 11 with Claude Code is
partly verified; the other combinations are supported but not yet verified. 1.0.0 is
released only after all twelve operating system and coding tool combinations above are
verified on the release.

## Security fixes

We aim to acknowledge a report within 3 business days and, for a confirmed critical or
high severity issue in a supported version, to publish a fixed release or a workaround
within 14 days, with a security advisory once it is fixed. Medium and low severity
issues are fixed in the next regular release.
