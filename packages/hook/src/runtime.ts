// The hook runtime: a check-only (M0) gateway built once from the enrolled
// machine key, policy and a durable local receipt log. Each mapped action is
// signed by the machine key, decided against policy and countersigned — locally,
// with no HTTP server and no Cloud dependency in 0.1.

import { readFileSync } from "node:fs";
import { createGateway, StaticPrincipalKeyRegistry, type CloudExporter } from "@scopebond/gateway";
import { loadOrCreateAttester, openReceiptStore } from "@scopebond/gateway/node";
import { createSigner } from "@scopebond/sdk";
import type { Mapped } from "./map.js";
import { attachExporter, flushBounded, type HookConnection } from "./cloud.js";

export interface RuntimeConfig {
  policyPath: string;
  keyPath: string;
  attesterPath: string;
  dbPath: string;
  /** Strict mode: an unmapped tool is policy-checked (and denied by a closed
   *  allowlist) instead of observed. Fail-closed for tools with no taxonomy
   *  mapping; default false (observe, matching the connector conformance vector). */
  strict?: boolean;
  /** When connected to a Cloud workspace, receipts are auto-exported to the portal.
   *  Export is best-effort and never changes the local decision. */
  cloud?: { connection: HookConnection; fetch?: typeof fetch; flushTimeoutMs?: number };
}

export interface Decision {
  decision: "allow" | "deny" | "not_evaluated";
  reason: string;
  /** The deciding receipt (the denied one, or the first allow). */
  receipt?: unknown;
  /** Every receipt produced — one per simple command in a decomposed shell call. */
  receipts?: unknown[];
}

// The hook's own config and keys must be off-limits to the agent it governs:
// otherwise the agent could rewrite its policy or read the signing keys and the
// receipts stop meaning anything. These patterns are "allow if the path does NOT
// match a protected location"; they run against the cwd-relative path the mapper
// produces (and equally against an absolute one).
//
// Matching is case-insensitive — Windows and macOS open `.ENV` and `.env` as the
// same file — by expanding each letter to a two-case class (policy patterns are
// plain regular expressions with no flags). `ci()` is applied to literal text only.
const ci = (s: string): string => s.replace(/[A-Za-z]/g, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
const under = (dir: string): string => `(?!(?:.*/)?${ci(dir)}(?:/|$))`;    // dir itself or anything inside it
const named = (file: string): string => `(?!(?:.*/)?${ci(file)}$)`;         // exactly this file name
const dir = (d: string): string => `(?!(?:.*/)?${ci(d)}/?$)`;               // the directory itself (a recursive read or copy)

const PROTECTED_WRITE = "^" + [
  under("\\.scopebond"), `(?!(?:.*/)?${ci("\\.claude/settings")})`, under("\\.claude/hooks"), under("\\.claude/agents"),
  `(?!(?:.*/)?${ci("\\.cursor/hooks")})`, named("\\.codex/hooks\\.json"), named("\\.codex/config\\.toml"), named("\\.mcp\\.json"),
  under("\\.git/hooks"), named("\\.git/config"), under("\\.husky"),
  under("\\.github/workflows"), under("\\.github/actions"), named("\\.gitlab-ci\\.yml"), named("\\.gitlab-ci\\.yaml"), under("\\.circleci"),
  named("azure-pipelines\\.yml"), named("Jenkinsfile"),
].join("") + ".+";

const PROTECTED_READ = "^" + [
  under("\\.scopebond"),
  `(?!.*${ci("\\.(?:key|pem|p12|pfx|jks|keystore)")}$)`,
  // .env, .env.* — except templates whose name ends in .example/.sample/.template/.dist
  `(?!(?:.*/)?${ci("\\.env")}(?!(?:\\.[^/]*)?\\.(?:${ci("example")}|${ci("sample")}|${ci("template")}|${ci("dist")})$)(?:\\.[^/]*)?$)`,
  named("\\.envrc"),
  // Credentials outside the workspace that an agent can reach by absolute or ~ path,
  // and their directories as a whole (`cp -r ~/.ssh`, `grep -r x ~/.aws`).
  `(?!(?:.*/)?${ci("\\.ssh")}(?:$|/(?!.*${ci("\\.pub")}$)(?!${ci("known_hosts")}$)(?!${ci("config")}$)))`,
  `(?!(?:.*/)?${ci("\\.aws")}(?:$|/(?!${ci("config")}$)))`,
  named("\\.npmrc"), named("\\.pypirc"), named("\\.netrc"), named("_netrc"), named("\\.git-credentials"),
  dir("\\.kube"), named("\\.kube/config"), dir("\\.docker"), named("\\.docker/config\\.json"),
  under("\\.config/gcloud"), under("\\.azure"), under("\\.gnupg"),
  dir("\\.config/gh"), named("\\.config/gh/hosts\\.yml"), named("\\.claude/\\.credentials\\.json"),
].join("") + ".+";

// Destructive programs, POSIX and Windows. The mapper records the program as typed,
// so the pattern accepts any case and an executable suffix (`RM.exe`, `Remove-Item`).
const DESTRUCTIVE = [
  "rm", "sudo", "doas", "shutdown", "reboot", "halt", "poweroff", "mkfs", "dd", "shred", "truncate", "unlink", "wipe", "srm",
  "del", "rd", "rmdir", "erase", "deltree", "format", "diskpart", "remove-item", "ri", "clear-content", "clc", "stop-computer", "restart-computer",
];
const SAFE_SHELL = `^(?!(?:${DESTRUCTIVE.map(ci).join("|")})(?:${ci("\\.(?:exe|cmd|bat|com|ps1)")})?$).+`;

// A push destination the starter policy refuses: main, master, release/*, the
// "every branch" flags (`--all`, `--mirror`, `--branches`) and a push whose
// destination the mapper could not read (`--unknown`: a git alias, a configured push
// refspec, `send-pack`), in any case. `--tags` alone pushes only tags and is allowed.
const SAFE_REF = `^(?!(?:${ci("main")}|${ci("master")})$)(?!${ci("release")}/)(?!-(?!-${ci("tags")}$)).+`;

// Patterns written by earlier starter policies (0.3–0.5), upgraded in memory when a
// policy on disk still carries them verbatim. An operator's own edits never match
// these strings and are left untouched.
const LEGACY_STARTER_PATTERNS: Record<string, string> = {
  "^(?!(?:main|master)$)(?!release/).+": SAFE_REF,
  "^(?!(?:rm|sudo|shutdown|reboot|mkfs|dd|del|rd|rmdir|erase|deltree|format|Remove-Item|ri)$).+": SAFE_SHELL,
  "^(?!(?:rm|sudo|shutdown|reboot|mkfs|dd)$).+": SAFE_SHELL,
  "^(?!(?:.*/)?\\.scopebond/)(?!(?:.*/)?\\.claude/settings)(?!(?:.*/)?\\.cursor/hooks)(?!(?:.*/)?\\.codex/(?:hooks\\.json|config\\.toml)$)(?!(?:.*/)?\\.git/hooks/)(?!(?:.*/)?\\.github/workflows/)(?!(?:.*/)?\\.github/actions/)(?!(?:.*/)?\\.gitlab-ci\\.yml$)(?!(?:.*/)?\\.circleci/)(?!(?:.*/)?azure-pipelines\\.yml$)(?!(?:.*/)?Jenkinsfile$).+": PROTECTED_WRITE,
  "^(?!(?:.*/)?\\.scopebond/)(?!(?:.*/)?\\.claude/settings)(?!(?:.*/)?\\.cursor/hooks)(?!(?:.*/)?\\.git/hooks/)(?!(?:.*/)?\\.github/workflows/)(?!(?:.*/)?\\.github/actions/)(?!(?:.*/)?\\.gitlab-ci\\.yml$)(?!(?:.*/)?\\.circleci/)(?!(?:.*/)?azure-pipelines\\.yml$)(?!(?:.*/)?Jenkinsfile$).+": PROTECTED_WRITE,
  "^(?!(?:.*/)?\\.scopebond/)(?!(?:.*/)?\\.claude/settings)(?!(?:.*/)?\\.cursor/hooks)(?!(?:.*/)?\\.git/hooks/).+": PROTECTED_WRITE,
  "^(?!(?:.*/)?\\.scopebond/)(?!.*\\.key$)(?!(?:.*/)?\\.env(?:\\.(?!example$|sample$|template$)[^/]*)?$).+": PROTECTED_READ,
  "^(?!(?:.*/)?\\.scopebond/)(?!.*\\.key$).+": PROTECTED_READ,
};

/** Upgrade the starter-policy patterns an older hook wrote, in memory, so a user who
 *  installed an earlier version gets the current protections without re-running init.
 *  Only exact legacy strings are replaced; any other pattern is the operator's own. */
export function upgradeStarterPolicy<T>(policy: T): T {
  const p = policy as { clauses?: Array<{ param_bounds?: Record<string, { pattern?: string }> }> };
  for (const clause of p?.clauses ?? []) {
    for (const bound of Object.values(clause?.param_bounds ?? {})) {
      if (bound && typeof bound.pattern === "string" && LEGACY_STARTER_PATTERNS[bound.pattern]) bound.pattern = LEGACY_STARTER_PATTERNS[bound.pattern];
    }
  }
  return policy;
}

/** The default starter policy for a coding agent: protect release branches, deny
 *  destructive programs, allow workspace file access except the hook's own config
 *  and keys, and trust only the enrolled machine key. Every threshold is the
 *  operator's to edit. */
export function starterPolicy(agentKid: string): Record<string, unknown> {
  return {
    vocabulary_version: "1.0", policy_id: "coding-agent", version: 1,
    clauses: [
      {
        id: "protect-branches", type: "action_allowlist", mode: "enforce", action_types: ["git.push"],
        param_bounds: { ref: { pattern: SAFE_REF } },
        description: "Deny pushes to main, master and release/* (any case, any refspec spelling), pushes of every branch at once (--all, --mirror) and pushes whose destination cannot be read from the command (a git alias, a configured push refspec, send-pack). A tags-only push (--tags) is allowed.",
      },
      {
        id: "safe-shell", type: "action_allowlist", mode: "enforce", action_types: ["shell.exec"],
        param_bounds: { program: { pattern: SAFE_SHELL } },
        description: "Deny destructive programs — POSIX (rm, sudo, doas, shutdown, reboot, mkfs, dd, shred, truncate, unlink, wipe) and Windows/PowerShell (del, rd, rmdir, erase, deltree, format, diskpart, Remove-Item, Clear-Content) — in any case and with or without .exe. An empty program (a command that could not be parsed, or whose program is only known at run time: $VAR, $(…), eval of a variable) is denied. Argument-shaped deletion (find -delete, git clean) is not a program name and is not covered here.",
      },
      {
        id: "protect-write", type: "action_allowlist", mode: "enforce", action_types: ["file.write"],
        param_bounds: { path: { pattern: PROTECTED_WRITE } },
        description: "Allow workspace writes, but never to the hook's policy/keys, Claude Code settings, hooks and agents, Cursor or Codex hook settings, .mcp.json, git hooks and git config, Husky hooks, or CI config (.github/workflows, .github/actions, .gitlab-ci.yml/.yaml, .circleci, azure-pipelines.yml, Jenkinsfile). Case-insensitive.",
      },
      {
        id: "protect-read", type: "action_allowlist", mode: "enforce", action_types: ["file.read"],
        param_bounds: { path: { pattern: PROTECTED_READ } },
        description: "Allow workspace reads, but never signing keys and key containers (*.key, *.pem, *.p12, *.pfx, *.jks), environment secret files (.env, .env.*, .envrc — except names ending in .example/.sample/.template/.dist), SSH private keys and the .ssh directory, cloud/registry/git credentials (.aws except .aws/config, .npmrc, .pypirc, .netrc, .git-credentials, .kube/config, .docker/config.json, gcloud, Azure, GnuPG, the GitHub CLI's hosts.yml, Claude Code's .credentials.json) or the hook's own .scopebond directory. Case-insensitive.",
      },
      {
        id: "observe-net-mcp", type: "action_allowlist", mode: "monitor",
        action_types: ["net.fetch", "mcp.tool.call"],
        description: "Observe network fetches and MCP tool calls (recorded, not blocked) — add bounds to enforce.",
      },
      { id: "keys", type: "key_policy", active_keys: [agentKid], description: "Only the enrolled machine key may sign." },
    ],
  };
}

/** Build the runtime. Throws on any setup failure (unparseable policy, missing
 *  key, unavailable store) — the CLI turns that into a fail-closed deny. */
export function createHookRuntime(config: RuntimeConfig) {
  const policy = upgradeStarterPolicy(JSON.parse(readFileSync(config.policyPath, "utf8")));
  const agent = createSigner({ privateKeyPem: readFileSync(config.keyPath, "utf8") });
  const keys = new StaticPrincipalKeyRegistry([
    { kid: agent.kid, publicKeyPem: agent.publicKeyPem, purposes: ["agent"], status: "active" },
  ]);
  const { attester } = loadOrCreateAttester({ file: config.attesterPath });
  const { store: baseStore } = openReceiptStore({ db: config.dbPath });
  // When connected, mirror every stored receipt to the hosted portal through a
  // durable outbox. The wrapped store's decision is unchanged; export is best-effort.
  let store = baseStore;
  let exporter: CloudExporter | undefined;
  if (config.cloud) {
    const attached = attachExporter(config.dbPath + ".cloud-outbox.db", config.cloud.connection, baseStore, config.cloud.fetch);
    store = attached.store;
    exporter = attached.exporter;
  }
  const gateway = createGateway({ policy, authentication: { keys }, attester, store, mode: "check_only" });

  return {
    gateway,
    agentKid: agent.kid,
    exporter,
    /** Deliver queued receipts to Cloud with a bounded timeout, then it is safe to
     *  exit. Undelivered receipts persist in the durable outbox for the next run. */
    async flush(): Promise<void> {
      if (exporter) await flushBounded(exporter, config.cloud?.flushTimeoutMs);
    },
    /** Decide one mapped action, recording a receipt either way. */
    async evaluateOne(mapped: Mapped): Promise<Decision> {
      const signed = agent.sign(mapped.intent);
      if (!mapped.evaluated && !config.strict) {
        // Unknown tool or unparseable command, non-strict: observe without
        // evaluating — grants nothing (D30).
        const { receipt } = await gateway.observeAction({ intent: signed.intent, authorization: signed.authorization });
        return { decision: "not_evaluated", reason: `no policy applies to ${mapped.intent.action_type}`, receipt };
      }
      // Evaluated actions, and (in strict mode) unmapped tool.<name>/opaque commands,
      // go through policy — a closed allowlist denies an unlisted action.
      const result = await gateway.handleAction({ intent: signed.intent, authorization: signed.authorization });
      return { decision: result.allowed ? "allow" : "deny", reason: result.reason, receipt: result.receipt };
    },
    /** Decide a whole tool call. A shell call decomposes into several simple
     *  commands; every one is recorded, and a single deny denies the call. */
    async evaluate(mapped: Mapped | Mapped[]): Promise<Decision> {
      const list = Array.isArray(mapped) ? mapped : [mapped];
      if (list.length === 0) return { decision: "not_evaluated", reason: "no action", receipts: [] };
      const receipts: unknown[] = [];
      let allow: Decision | null = null;
      let notEvaluated: Decision | null = null;
      for (const m of list) {
        const d = await this.evaluateOne(m);
        if (d.receipt !== undefined) receipts.push(d.receipt);
        if (d.decision === "deny") return { ...d, receipts };            // any deny denies the call
        if (d.decision === "allow" && !allow) allow = d;
        if (d.decision === "not_evaluated" && !notEvaluated) notEvaluated = d;
      }
      // No deny: allow if any command was evaluated-and-allowed, else not_evaluated.
      const chosen = allow ?? notEvaluated!;
      return { ...chosen, receipts };
    },
  };
}
