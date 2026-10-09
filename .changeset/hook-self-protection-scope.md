---
"@scopebond/hook": patch
---

The always-on protection no longer refuses ordinary work. It now counts a coding agent as started with its config folder moved only when the agent is actually launched with or after the variable change, not when its name appears in a commit message or argument. It protects agent settings folders only where they belong to this project or this home folder: a vendored or temporary `.git`, a test fixture's `.claude`, brace-listed build folders, filtered deletes and a `git clean -x` that cannot reach Scopebond's folder are allowed again. Git configuration is read from the environment only through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_PARAMETERS`, so a redirected `HOME` or config file no longer turns a feature-branch push, `git lfs` or `git flow` into an unknown push.
