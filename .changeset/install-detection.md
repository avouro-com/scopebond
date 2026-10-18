---
"@scopebond/hook": minor
---

Detect installs on every route and record each as a `software.install` action beside the command or file write that does it: npm, pnpm, yarn, bun and npx; pip, uv, poetry and pipx; cargo, go, gem and brew; `curl … | sh` and its variants, downloads that are run or are programs, `git clone` (and a clone whose scripts run), `docker pull` and `docker run`, and MCP servers added through `claude mcp add`, `codex mcp add`, `code --add-mcp` or a write to a coding tool's MCP settings file. Detection only: the action is visible to rules and rides in the signed receipt, and never carries file contents, credentials, query strings or a server's environment values. Reading a cached rule pack now checks the file's type and size on the descriptor it reads.
