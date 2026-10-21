# Scope policy

This repository contains Scopebond's free, Apache-2.0 open-source engine for AI coding
agents: Claude Code, Cursor, Codex, GitHub Copilot, MCP, framework tools, and GitHub
pull requests. It checks supported actions routed through configured connections,
blocks what your rules say to block, and produces records anyone can verify offline.
Scopebond Cloud, the hosted service, is a separate proprietary product and is not
included.

This is the contract that decides what belongs in this repository. It is written for
two readers: contributors, and the **automated scope-review agent** that reads every
pull request and issue and judges it against this document. Keep it precise: the
agent's verdict is only as good as this document.

## The rule: engine or knowledge?

- **Engine belongs here.** How to read, decide, enforce, record or verify, written so
  it is true of any tool. Examples: tool adapters, the shell parser, the rule
  language, git and package-install detection, receipts, verification, and the client
  code that talks to Scopebond Cloud.
- **Knowledge does not.** What is risky about a specific vendor CLI, cloud API, MCP
  server, website or package, and curated rule catalogs. That is maintained as rule
  packs in Scopebond Cloud.
- **The exception: the starter protections.** Protected branches, destructive shell
  commands, secret files, and Scopebond's own settings stay here, because core safety
  is always free.
- **Where vendor coverage comes from.** The hook carries no readers for vendor
  command-line tools or MCP servers. What a cloud, Kubernetes, database, deployment or
  secret tool's command does, or what a known MCP server's tool does, is read through
  signed rule packs that Scopebond Cloud delivers; the packs also bring the rules for
  those actions. Without a pack, the hook runs the open detection and the starter
  protections. Two observation readers remain in the engine until the pack format can
  describe observation output: Wrangler's resource and D1 operations, and GitHub's CLI
  and API calls.
- **Checked automatically.** The OSS gate (`scripts/oss-gate.mjs`) refuses package
  source that names a known vendor program or MCP tool, outside the engine code it
  lists with a reason.

## In scope

- **Enforcement:** the hook, the agent and the gateway evaluate the policy vocabulary
  before an action runs, deny out-of-policy actions, and fail closed.
- **Tool adapters:** turning each supported coding agent's tool calls into actions,
  and shell decomposition.
- **Detection:** recognising an action's type from the actual request, for example a
  git push or a package install, without vendor-specific risk knowledge.
- **The rule language and the starter protections,** plus running rule packs that
  Scopebond Cloud delivers as signed data.
- **Receipts:** countersigning actions in the `scopebond:receipt` envelope.
  Receipts attest to occurrence and content; they are not a compliance verdict.
- **Kill switch:** halting execution for one or all agents, failing closed.
- **Verification:** `@scopebond/verify`, the policy schema, the test vectors and the
  conformance suite. Deterministic and reproducible, with no network and no clock.
- **The client side of Scopebond Cloud:** connecting, delivering records, and
  receiving signed rules, so anyone can read exactly what runs on their computers.
- **Integrations** as separate leaf packages that emit `scopebond:receipt`.
- Docs, examples, tests and tooling for the above.

## Out of scope (reject or route to a maintainer)

- **Vendor or ecosystem knowledge:** new CLI, cloud API, MCP server, website or package
  profiles; curated rule lists; malicious-package, typo-squat or domain-reputation
  data or verdicts. These belong in Scopebond Cloud rule packs.
- **Analytics, customer dashboards, inventory, approvals workflows, or compliance
  reporting.**
- **The hosted service:** tenancy, billing, SSO, retention, quotas, the hosted portal.
  It is proprietary and lives in a separate repository.
- **Anything custodial:** code that lets Scopebond hold a customer's keys or secrets.
- **Vendor or agent-framework SDK dependencies inside a core package**
  (`policy-schema`, `verify`, `gateway`, `sdk`). External services go behind an
  interface with a local implementation; framework glue is a leaf package.
- **Remote code:** downloading and running code from a server. Rule packs are data,
  never code.
- **Learning, tuning or model code,** and any data set or model file (see "Closed
  components").

## Closed components

Some parts of Scopebond are proprietary and never enter this repository:

- **Learning and tuning:** how Scopebond Cloud learns from activity and suggests rule
  changes, including its data model, methods, thresholds, prompts, test sets and
  everything it produces.
- **Curated rule packs** and Safe Install intelligence (see "engine or knowledge?").

The open engine reaches a closed component only through a **generic plugin
interface** in the hook, and records carry its output in one **opaque `intel` slot**
that the open code stores and verifies as bytes without describing what is inside.
Without the plugin (any build from this repository), the slot is empty and the engine
behaves exactly the same. What a computer sends to Scopebond Cloud stays open: the
client code that sends it is here, and the hook prints the next upload on request.

Checked automatically: the OSS gate refuses a package for the closed component,
training code, notebooks, data sets and model files, machine-learning or
model-provider dependencies, imports of the closed module by name, and the closed
system's identifiers.

## Hard constraints (a change that breaks one is rejected regardless of merit)

- **Fail closed.** Deny by default; unparseable input denies or goes stale; never "no limit."
- **No file contents, prompts or secrets** in receipts, anchors or evidence.
- **Determinism** of verification: no network or wall-clock reads; the evaluation
  timestamp is an input; ambiguity resolves for the operator.
- **Closed schema.** Unknown clause types or fields make a policy invalid.
- **No secrets, no private material, no prior-project codenames.** The OSS gate enforces this.
- **Trademark.** A fork must rename; "Scopebond-compatible" requires passing the conformance suite.

## How the agent should decide

For each PR or issue, classify it as one of:

- **ALIGNED:** within "In scope" and breaks no hard constraint. Proceed to normal review.
- **NEEDS-CHANGES:** in scope, but it violates a constraint or a package rule that the
  author can fix. Explain precisely what to change.
- **OUT-OF-SCOPE:** matches "Out of scope", or expands scope, adds a new package, or
  changes a public interface or a settled decision. **Do not close it; label it and
  route it to a maintainer** for a human decision.

Always cite the specific rule above. When genuinely uncertain, prefer NEEDS-CHANGES or
OUT-OF-SCOPE (route to a human) over ALIGNED: a false "aligned" is the costly error.
