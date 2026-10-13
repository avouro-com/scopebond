---
"@scopebond/hook": minor
---

Repository enrolment for runs with no person signed in: Claude Code on the web, Codex cloud tasks, the GitHub Copilot
coding agent and agent steps in GitHub Actions.

`init --repo` writes only the committed hook files, `.claude/settings.json`, `.codex/hooks.json` and
`.github/hooks/scopebond.json`, each with the version-pinned `npx -y @scopebond/hook@<version> <agent> --from-repo`
command (the Copilot entries as `bash` commands, the only form its cloud agent runs). It merges with what each file holds
(in Claude Code and Codex only Scopebond's own entry leaves a matcher group), replaces an earlier Scopebond entry instead
of adding a second, writes no backups, keys or `.scopebond` folder, and writes the three files together: all change or
none does, and a file that is not JSON stops it first. `--dry-run` shows what it would write.

A hook with `SCOPEBOND_REPO_TOKEN` set and no connection of its own sets itself up in the home folder, proves possession
of its fresh keys over the token's digest and the time, exchanges the token at `POST /v1/repository/enroll` for a
short-lived delivery credential for that one repository (`cloud.json`, marked `"source": "repository"` with a fingerprint
of the token, never the token), and denies every call until the workspace's rules have loaded once. A credential that ran
out, or one made with another repository's token, is set aside with its folder and the repository enrols again with fresh
keys. A person's own connection always wins and is looked for before the token is read. `SCOPEBOND_URL` names a workspace
other than `https://cloud.scopebond.com`. The token is never written, printed or sent anywhere else; a refused or
unreachable enrolment denies the call with the reason.

A committed (`--from-repo`) entry on a computer with no repository token and no Scopebond connection checks nothing: it
says so once on stderr, records nothing and leaves the decision to the agent. A token or a person's connection keeps the
usual checks. The GitHub Copilot "not set up" deny and the Copilot coverage note name the repository token. These cloud
runs are not verified yet, and the committed files are not a boundary on their own: keep the GitHub Action as the merge
check.
