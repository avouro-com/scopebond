---
"@scopebond/policy-schema": minor
---

Action Taxonomy 1.2 adds `software.install`: software a coding agent installs or runs from outside the project, by any route (package managers and runners, a script piped to a shell, a downloaded program, a cloned repository whose scripts run, a container image, an MCP server added to a tool's settings). It carries the route, ecosystem, verb, name, version, source URL and domain, and no verdict. `vectors/install-detection.json` holds the conformance cases for every route.
