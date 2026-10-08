# @scopebond/framework

**License and hosting:** this package is free, Apache-2.0 open-source software.
Scopebond Cloud, the hosted shared workspace, is a separate proprietary service
and is not included in this package.

Add a guard so supported tools check your policy before execution and record a
signed receipt. The framework must call the guard and honor its decision; tools
outside the guarded loop are not covered.

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
`wrapVercelTools` throws on a tool with no `execute` (a client-side tool), rather
than pass it through unchecked: keep such tools out of the record you wrap.

## LangGraph / LangChain

```js
import { createToolGuard, wrapLangGraphTool } from "@scopebond/framework";

const guard = createToolGuard({ policy, agentKeyPem });
const guardedSearch = wrapLangGraphTool(searchTool, guard);
// use guardedSearch anywhere the original tool went (ToolNode, bindTools, …)
```

Every way the tool can run is guarded: `invoke`, `call`, `_call`, `func`, `stream`
and `batch`.

## Other frameworks

Any framework whose tools have a `name` and an async `execute` is covered:

```js
import { guardedTool, wrapOpenAITools, guardExecute } from "@scopebond/framework";

const guarded = guardedTool(myTool, guard);            // { name, execute }
const guardedList = wrapOpenAITools(agentTools, guard); // OpenAI Agents SDK array
const safeExecute = guardExecute("send_email", sendEmail, guard); // any function
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

## What a receipt keeps of the tool's arguments

A receipt records the tool's arguments as `intent.params`. Before the receipt is
signed, stored or sent anywhere, each field is minimized:

| Field | What the receipt keeps |
|---|---|
| A credential-named key (`authorization`, `cookie`, `password`, `secret`, `token`, `api_key`, `*_token`, `*_secret`, …) | `[REDACTED]` |
| `body` / `request_body` | a SHA-256 digest and the byte length |
| `asset`, `amount`, `currency` (and the action type) | the value exactly as given (spend limits read them) |
| Any other string | the value, with credential shapes inside it replaced by `***`: a credential-named URL query parameter (`?api_token=…`), URL userinfo (`https://user:pass@…`), a SQL password literal (`PASSWORD '…'`, `IDENTIFIED BY '…'`), an `Authorization: Bearer …` header, a `NAME=value` with a credential-like name, and well-known token formats (GitHub, GitLab, npm, Slack, Stripe, AWS, Google, JWT, PEM private keys) |
| Numbers, booleans | the value |

Each path that was changed is listed in the receipt's `redaction.paths`. The policy
check runs on the original arguments; only the receipt holds the minimized copy.
Scrubbing recognises shapes, not meaning: a password in a field with an ordinary
name and no recognisable shape, a recipient's email address, or personal data in a
free-text field other than `body` stays as written. Keep such values out of tool
arguments you guard, or map the tool to an action whose parameters you control.

## Scopebond Cloud

```js
import { createToolGuard, connectCloud } from "@scopebond/framework";

const connection = await connectCloud(attesterKeyPem, workspaceUrl, enrollmentBundle);
const guard = createToolGuard({
  policy, agentKeyPem, attesterKeyPem,
  cloud: { connection, outboxPath: "./scopebond-outbox.db" },
});
```

With `outboxPath`, receipts wait in a durable SQLite queue with no cap and no
expiry, so an outage or a restart delays them instead of losing them (needs Node
22.5 or later). Without it, the queue is in memory, bounded at 10,000 records, and
anything still waiting when the process exits is lost. A record dropped at the bound
takes its sequence number first, so the workspace shows it as missing. Every gap is
passed to `cloud.onGap` (a warning on stderr by default). Call `guard.flush()` before
the process exits.

Experimental alpha; controlled test use only.
