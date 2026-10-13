---
"@scopebond/hook": minor
---

Repository enrolment for runs with no person signed in: Claude Code on the web, Codex cloud tasks, the GitHub Copilot
coding agent and agent steps in GitHub Actions.

`init --repo` writes only the committed hook files, `.claude/settings.json`, `.codex/hooks.json` and
`.github/hooks/scopebond.json`, each with the version-pinned `npx -y @scopebond/hook@<version> <agent>` command (the
Copilot entries as `bash` commands, the only form its cloud agent runs). It merges with what each file holds, replaces an
earlier Scopebond entry instead of adding a second, writes no backups, keys or `.scopebond` folder, and refuses before
writing anything when one of the files is not JSON. `--dry-run` shows what it would write.

A hook with `SCOPEBOND_REPO_TOKEN` set and no connection of its own now sets itself up in the home folder, proves
possession of its fresh keys over the token's digest and the time, exchanges the token at `POST /v1/repository/enroll`
for a short-lived delivery credential for that one repository (`cloud.json`, marked `"source": "repository"`), loads the
workspace's rules and decides the call. `SCOPEBOND_URL` names a workspace other than `https://cloud.scopebond.com`. An
expired repository credential is enrolled again rather than renewed; a person's own connection always wins. The token is
never written, printed or sent anywhere else; a refused or unreachable enrolment denies the call with the reason.

The GitHub Copilot "not set up" deny and `init --copilot` now name the repository token as the way to cover the cloud
agent. These cloud runs are not verified yet, and the committed files are not a boundary on their own: keep the GitHub
Action as the merge check.
