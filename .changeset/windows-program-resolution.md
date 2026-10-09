---
"@scopebond/gateway": patch
"@scopebond/hook": patch
"@scopebond/agent": patch
"@scopebond/github-action": patch
"@scopebond/mcp": patch
---

Programs started by name are no longer looked up in the current folder, which Windows otherwise searches before PATH: `git`, `npm` and an MCP upstream named without a folder come from the absolute folders on PATH, and Windows' own tools (`icacls`, `reg`, `powershell`, `cmd`, `conhost`, `explorer`) from the system folder. A `git.exe` or similar placed in a project, or in a pull request's checkout, is no longer run by the hook, the agent, the MCP proxy or the pull request check; a program that cannot be found that way is not started. `@scopebond/gateway/node` exports the lookup as `findProgram`, `programPath` and `windowsSystemProgram`.
