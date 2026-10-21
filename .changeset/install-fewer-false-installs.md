---
"@scopebond/hook": patch
"@scopebond/policy-schema": patch
---

A response fetched with `curl`, `wget` or `iwr` and piped to an interpreter that is given its code another way (`| python -c "…"`, `| python -m json.tool`, `| node -e`, `| ruby -e`, `| perl -e`, `| php -r`, `| deno eval`, `| bun -e`, or a local script such as `| node script.mjs`) is no longer recorded as running a fetched script, since the fetched text is only data; a bare interpreter (`| python`, `| node -`) and a shell still are, also when the text reaches them through filters (`| tee log | bash`), and the install-detection vectors cover each case.

A package runner's command arguments are no longer read as packages: `npx vite --port 4333`, `npx tsc -p tsconfig.json` and `pnpm dlx shadcn@latest add button` record only the command's package, `-y`/`--yes` after the command no longer marks the run as auto-confirmed, and every `-p`/`--package` before the command (or `--from`/`--spec` for `uvx` and `pipx run`) is recorded as a package of its own.
