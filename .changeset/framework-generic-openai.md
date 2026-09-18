---
"@scopebond/framework": minor
---

Extend `@scopebond/framework` with framework-agnostic guards so any tool-calling framework is covered, not only Vercel AI and LangGraph:

- `guardExecute(name, execute, guard)` wraps a single async tool function so it checks policy first (a denied call returns a synthetic denial result).
- `guardedTool({ name, execute }, guard)` wraps a function tool and preserves its other fields.
- `wrapOpenAITools(tools, guard)` guards an OpenAI Agents SDK tools array.

These cover the common `name` + `execute` shape used by the OpenAI Agents SDK, CrewAI, the Claude Agent SDK's MCP tools and others, without a framework dependency.
