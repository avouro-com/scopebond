# @scopebond/framework

One import so an agent checks your policy **before every tool call** and records a
signed receipt — the same policy your other agents use. Cooperative (M0): the
framework asks Scopebond first and honors the answer.

- **Label:** cooperative · prevents if honored. Enforcement depends on the
  framework honoring the guard; code that calls a tool outside the framework's
  tool loop is not covered.
- **Receipt class:** signed-intent — the agent's key signs the intent, so it is
  the strongest evidence class.

Adapters for the **Vercel AI SDK** and **LangGraph/LangChain** ship here; each
framework is an optional peer, never a dependency.

## Vercel AI SDK

```js
import { createToolGuard, wrapVercelTools } from "@scopebond/framework";
import { generateText } from "ai";

const guard = createToolGuard({ policy, agentKeyPem, manifest: { transfer: "payout.create" } });

const result = await generateText({
  model,
  tools: wrapVercelTools(myTools, guard), // each tool checks policy before it runs
  prompt,
});
```

A denied call returns a synthetic denial result to the model instead of executing.

## LangGraph / LangChain

```js
import { createToolGuard, wrapLangGraphTool } from "@scopebond/framework";

const guard = createToolGuard({ policy, agentKeyPem });
const guardedSearch = wrapLangGraphTool(searchTool, guard);
// use guardedSearch anywhere the original tool went (ToolNode, bindTools, …)
```

## Policy

Tools are governed by name via the Action Taxonomy's `tool.<name>` type (or a
manifest mapping to a richer type). "Allow search and read; cap transfers":

```json
{
  "vocabulary_version": "1.0", "policy_id": "agent", "version": 1,
  "clauses": [
    { "id": "tools", "type": "action_allowlist", "mode": "enforce", "action_types": ["tool.search", "tool.read", "payout.create"] },
    { "id": "cap", "type": "spend_limit", "mode": "enforce", "asset": "USDC", "max_per_action": 100000 }
  ]
}
```

An unlisted tool is denied by the closed allowlist (fail closed). `createToolGuard`
returns `{ check(name, args) }` if you drive the tool loop yourself.

Experimental alpha; controlled test use only.
