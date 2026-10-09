// The hook runtime: a check-only (M0) gateway built once from the enrolled
// machine key, policy and a durable local receipt log. Each mapped action is
// signed by the machine key, decided against policy and countersigned — locally,
// with no HTTP server and no Cloud dependency in 0.1.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createGateway, StaticPrincipalKeyRegistry, withCloudExporter, type CloudExporter } from "@scopebond/gateway";
import { ensurePrivateDir, loadOrCreateAttester, openReceiptStore } from "@scopebond/gateway/node";
import { createSigner } from "@scopebond/sdk";
import type { Mapped } from "./map.js";
import { attachExporter, flushBounded, DeliveryQueueError, type HookConnection } from "./cloud.js";
import { explainDeny } from "./explain.js";
import { RULES_FILE, loadRules } from "./rules.js";
import { applyRootScope } from "./paths.js";
import { withActionGroup, actionGroupId, ACTION_GROUP_PARAM } from "./group.js";
import { cliCommand } from "./version.js";
import { deliveryBackoff, recordDeliveryAttempt } from "./delivery-state.js";
import { isRepairableStore, noteQueueMiss, repairDelivery } from "./delivery-repair.js";
import { openDispatchGuard, DELEGATION_ENV } from "@scopebond/gateway/node";
import { dispatchIntentOf, type DispatchDecision, type DispatchGuard, type OverrideHandler } from "@scopebond/gateway";

export interface RuntimeConfig {
  policyPath: string;
  keyPath: string;
  attesterPath: string;
  dbPath: string;
  /** Strict mode: an unmapped tool is policy-checked (and denied by a closed
   *  allowlist) instead of observed. Fail-closed for tools with no taxonomy
   *  mapping; default false (observe, matching the connector conformance vector). */
  strict?: boolean;
  /** The working directory the harness reported, used to resolve workspace roots when
   *  the rule set lists `allowed_roots`. Defaults to the process directory. */
  cwd?: string;
  /** When connected to a Cloud workspace, receipts are auto-exported to the portal.
   *  Export is best-effort and never changes the local decision. */
  cloud?: { connection: HookConnection; fetch?: typeof fetch; flushTimeoutMs?: number };
  /** How long a delivery-queue statement waits for another process's write lock. A tool call keeps it short
   *  (`HOT_PATH_QUEUE_BUSY_MS`), so an override wait plus a lock wait stays inside the coding agent's hook time limit; a write
   *  that fails then is kept as a gap and queued on the next flush. `flush` (no time limit) passes a longer one. */
  queueBusyTimeoutMs?: number;
  /** Warn mode: asked when policy denies an action, so a person may override a rule the workspace made overridable
   *  (see override.ts). `hint` explains, in a denial, how an override would have been possible. */
  override?: (agentKid: string) => { handler: OverrideHandler; hint(): string | null } | null;
}

export interface Decision {
  /** ask: a rule blocked it and the coding agent's own prompt asks the person (warn mode, Claude Code only). */
  decision: "allow" | "deny" | "not_evaluated" | "ask";
  reason: string;
  /** The clause that decided a deny, when the verdict named one. */
  clauseId?: string | null;
  /** The deciding receipt (the denied one, or the first allow). */
  receipt?: unknown;
  /** Every receipt produced — one per simple command in a decomposed shell call. */
  receipts?: unknown[];
  /** Each action as actually evaluated (after root scoping and grouping), with its
   *  receipt: what the observation emitters bind a request digest to. */
  /** What the dispatch boundary spent or refused for this call, when one is configured. */
  dispatch?: DispatchDecision;
  dispatched?: Array<{ action: { action_type: string; params: Record<string, unknown> }; receipt?: unknown }>;
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
export const ci = (s: string): string => s.replace(/[A-Za-z]/g, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
export const under = (dir: string): string => `(?!(?:.*/)?${ci(dir)}(?:/|$))`;    // dir itself or anything inside it
export const named = (file: string): string => `(?!(?:.*/)?${ci(file)}$)`;         // exactly this file name
export const dir = (d: string): string => `(?!(?:.*/)?${ci(d)}/?$)`;               // the directory itself (a recursive read or copy)

// The protected-write set, in two typed groups the catalog classifies separately:
// guardrail/hook configuration (C02) and CI configuration (H03).
const GUARDRAIL_WRITE_PREV = [
  under("\\.scopebond"), `(?!(?:.*/)?${ci("\\.claude/settings")})`, under("\\.claude/hooks"), under("\\.claude/agents"),
  `(?!(?:.*/)?${ci("\\.cursor/hooks")})`, named("\\.codex/hooks\\.json"), named("\\.codex/config\\.toml"), named("\\.mcp\\.json"),
  under("\\.git/hooks"), named("\\.git/config"), under("\\.husky"),
];
const CI_WRITE_PREV = [
  under("\\.github/workflows"), under("\\.github/actions"), named("\\.gitlab-ci\\.yml"), named("\\.gitlab-ci\\.yaml"), under("\\.circleci"),
  named("azure-pipelines\\.yml"), named("Jenkinsfile"),
];
const GUARDRAIL_WRITE = [...GUARDRAIL_WRITE_PREV, named("\\.cursor/mcp\\.json"), under("\\.githooks")];
const CI_WRITE = [
  ...CI_WRITE_PREV,
  named("azure-pipelines\\.yaml"), named("bitbucket-pipelines\\.yml"), named("\\.travis\\.yml"), named("\\.drone\\.yml"),
  named("cloudbuild\\.yaml"), named("cloudbuild\\.yml"), under("\\.buildkite"),
];
// What 0.8 compiled, kept so an installed policy that still carries it verbatim is
// upgraded in memory (see LEGACY_STARTER_PATTERNS).
const PROTECTED_WRITE_PREV = "^" + [...GUARDRAIL_WRITE_PREV, ...CI_WRITE_PREV].join("") + ".+";
const PROTECTED_WRITE = "^" + [...GUARDRAIL_WRITE, ...CI_WRITE].join("") + ".+";
/** The write protection that is always on, whoever manages the rules: the hook's own settings and those of the agents it
 *  guards. A workspace can relax CI-configuration writes; it can never relax these. */
export const GUARDRAIL_WRITE_PATTERN = "^" + GUARDRAIL_WRITE.join("") + ".+";
/** The always-on floor as bare lookaheads, for a pattern that must also refuse these paths (the hook's own folder included). */
export const GUARDRAIL_LOOKAHEADS = under("\\.scopebond") + GUARDRAIL_WRITE.join("");
/** The read protection that is always on, whoever manages the rules: the hook's own folder, which holds this computer's
 *  signing key and connection. A workspace can record other protected reads instead of blocking them; never this one. */
export const GUARDRAIL_READ_PATTERN = "^" + under("\\.scopebond") + named("cloud\\.json") + ".+";

/** Scopebond's own protection, always enforced and never relaxed by a rule set or a workspace: the hook's folder (its keys,
 *  connection and policy) and the coding agents' hook settings can be neither changed nor read by the coding agent, and an
 *  agent switching Scopebond off (uninstalling the hook or the agent, `autostart off`, `stop`, killing it) is mapped to a
 *  write to the hook's folder and so is stopped here. */
export function selfProtectionClauses(): Array<Record<string, unknown>> {
  return [
    {
      id: "protect-scopebond-write", type: "action_allowlist", mode: "enforce", action_types: ["file.write"],
      param_bounds: { path: { pattern: GUARDRAIL_WRITE_PATTERN } },
      description: "Never change Scopebond's own settings, keys and policy, or the coding agents' hook settings, and never switch Scopebond off (always on; it cannot be relaxed).",
    },
    {
      id: "protect-scopebond-read", type: "action_allowlist", mode: "enforce", action_types: ["file.read"],
      param_bounds: { path: { pattern: GUARDRAIL_READ_PATTERN } },
      description: "Never read Scopebond's own folder, which holds this computer's key and connection, or a copy of the connection file (cloud.json) anywhere (always on; it cannot be relaxed).",
    },
  ];
}

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
export const DESTRUCTIVE = [
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
  [PROTECTED_WRITE_PREV]: PROTECTED_WRITE,
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

/** The default starter policy for a coding agent. Monitor is the default: each rule records the actions it would have stopped
 *  (pushes to release branches, destructive programs, protected writes and reads) and lets them run; a rule blocks only once a
 *  person or the workspace turns it on. Scopebond's own protection is always enforced. Every threshold is the operator's to edit. */
export function starterPolicy(agentKid: string, opts: { enforce?: readonly string[] } = {}): Record<string, unknown> {
  const mode = (id: string): "enforce" | "monitor" => (opts.enforce?.includes(id) ? "enforce" : "monitor");
  return {
    vocabulary_version: "1.0", policy_id: "coding-agent", version: 1,
    clauses: [
      ...selfProtectionClauses(),
      {
        id: "protect-branches", type: "action_allowlist", mode: mode("protect-branches"), action_types: ["git.push"],
        param_bounds: { ref: { pattern: SAFE_REF } },
        description: "Deny pushes to main, master and release/* (any case, any refspec spelling), pushes of every branch at once (--all, --mirror) and pushes whose destination cannot be read from the command (a git alias, a configured push refspec, send-pack). A tags-only push (--tags) is allowed.",
      },
      {
        id: "safe-shell", type: "action_allowlist", mode: mode("safe-shell"), action_types: ["shell.exec"],
        param_bounds: { program: { pattern: SAFE_SHELL } },
        description: "Deny destructive programs — POSIX (rm, sudo, doas, shutdown, reboot, mkfs, dd, shred, truncate, unlink, wipe) and Windows/PowerShell (del, rd, rmdir, erase, deltree, format, diskpart, Remove-Item, Clear-Content) — in any case and with or without .exe. An empty program (a command that could not be parsed, or whose program is only known at run time: $VAR, $(…), eval of a variable) is denied. Argument-shaped deletion (find -delete, git clean) is not a program name and is not covered here.",
      },
      {
        id: "protect-write", type: "action_allowlist", mode: mode("protect-write"), action_types: ["file.write"],
        param_bounds: { path: { pattern: PROTECTED_WRITE } },
        description: "Allow workspace writes, but never to the hook's policy/keys, Claude Code settings, hooks and agents, Cursor or Codex hook settings, .mcp.json and .cursor/mcp.json, git hooks (.git/hooks, .githooks) and git config, Husky hooks, or CI config (.github/workflows, .github/actions, .gitlab-ci.yml/.yaml, .circleci, azure-pipelines, bitbucket-pipelines.yml, .travis.yml, .drone.yml, cloudbuild, .buildkite, Jenkinsfile). Case-insensitive.",
      },
      {
        id: "protect-read", type: "action_allowlist", mode: mode("protect-read"), action_types: ["file.read"],
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

/** How long a tool call's delivery-queue writes wait for another process's lock. Codex's hook entry allows 30 s and its
 *  override wait is 20 s; this, with the local log's shorter wait after an override (below), keeps a call inside it. */
export const HOT_PATH_QUEUE_BUSY_MS = 2_000;
/** How long the local log waits for a lock once a person has been asked (the override wait has used most of the time limit). */
const AFTER_OVERRIDE_STORE_BUSY_MS = 5_000;
/** How long the end-of-call repair pass waits for a lock before leaving the work to the next flush. */
const REPAIR_BUSY_MS = 250;
/** The local log's usual lock wait (the store's default). */
const STORE_BUSY_MS = 15_000;

/** Build the runtime. Throws on any setup failure (unparseable policy, missing
 *  key, unavailable store) — the CLI turns that into a fail-closed deny. */
export function createHookRuntime(config: RuntimeConfig) {
  // The keys, the credential, the receipt log and its journal files: readable by this user alone, those an older version
  // left included. Done once per folder; afterwards a small check.
  ensurePrivateDir(dirname(config.policyPath));
  const policy = upgradeStarterPolicy(JSON.parse(readFileSync(config.policyPath, "utf8").replace(/^\uFEFF/, "")));
  const agent = createSigner({ privateKeyPem: readFileSync(config.keyPath, "utf8") });
  const keys = new StaticPrincipalKeyRegistry([
    { kid: agent.kid, publicKeyPem: agent.publicKeyPem, purposes: ["agent"], status: "active" },
  ]);
  const { attester } = loadOrCreateAttester({ file: config.attesterPath });
  // When the project has a readable rule set, a denial names the command that edits it
  // rather than the generated file.
  const rulesRemedy = existsSync(join(dirname(config.policyPath), RULES_FILE))
    ? `run \`${cliCommand("rules")}\` to see the limits in plain terms, or edit ${join(dirname(config.policyPath), RULES_FILE)}`
    : undefined;
  const { store: baseStore } = openReceiptStore({ db: config.dbPath });
  // When connected, mirror every stored receipt to the hosted portal through a
  // durable outbox. The wrapped store's decision is unchanged; export is best-effort.
  let store = baseStore;
  let exporter: CloudExporter | undefined;
  let outbox: ReturnType<typeof attachExporter>["outbox"] | undefined;
  let deliveryUnavailable: string | null = null;
  const dir = dirname(config.dbPath);
  const repairable = isRepairableStore(baseStore) ? baseStore : null;
  if (config.cloud) {
    // Receipts this process writes have row ids above this one: a queue write that fails is noted with it, and the next
    // flush queues what the queue never got from there on.
    const after = repairable ? repairable.lastId() : 0;
    try {
      const attached = attachExporter(config.dbPath + ".cloud-outbox.db", config.cloud.connection, baseStore, config.cloud.fetch, {
        busyTimeoutMs: config.queueBusyTimeoutMs ?? HOT_PATH_QUEUE_BUSY_MS,
        onGap: (gap) => { if (gap.reason === "outbox_error") noteQueueMiss(dir, after, gap.id, gap.at); },
        // A wait the workspace asked for (429, or 503 with Retry-After) that an earlier call recorded holds for this call too.
        backoff: deliveryBackoff(dir),
      });
      store = attached.store;
      exporter = attached.exporter;
      outbox = attached.outbox;
    } catch (error) {
      // A full disk or a read-only or locked queue file does not stop the decision: the action stays allowed and its record
      // stays in the local log. The runtime reports the file and the fix as `deliveryUnavailable`, and each record written
      // meanwhile is noted so the next flush that can write the queue keeps the miss as a gap and queues the record.
      if (!(error instanceof DeliveryQueueError)) throw error;
      deliveryUnavailable = `${error.message}. ${error.repair}`;
      store = withCloudExporter(baseStore, {
        enqueue: (r) => noteQueueMiss(dir, after, r.payload.action_ref?.action_id ?? null),
        flush: async () => {}, stop: () => {}, pending: () => 0,
        status: () => ({ pending: 0, pendingBytes: 0, oldestEnqueuedAt: null, gaps: 0, retainedGapRecords: 0, latestGap: null, consecutiveFailures: 0, nextAttemptAt: null, lastSuccessAt: null, lastError: deliveryUnavailable }),
      });
    }
  }
  const scopeRoots = loadRules(dirname(config.policyPath))?.allowed_roots ?? [];
  // The dispatch boundary is checked once per tool call, after every intent has been allowed, so the
  // gateway's own per-intent hook only reports what the runtime already decided for this call.
  const boundary = openDispatchGuard(dirname(config.policyPath));
  let boundaryVerdict: DispatchDecision | null = null;
  const gatewayGuard: DispatchGuard = { authorize: () => Promise.resolve(boundaryVerdict ?? { allow: true, reason: "ok", consumed_approvals: [], budgets: [] }) };
  const gateway = createGateway({ policy, authentication: { keys }, attester, store, mode: "check_only", dispatchGuard: gatewayGuard });
  const made = config.override?.(agent.kid) ?? null;
  // Once a person has been asked, most of the hook's time limit is gone: the receipt that follows waits less for the local
  // log's lock (a write that still fails denies the call, and the open action is closed later as an interrupted one).
  const override = made ? {
    hint: () => made.hint(),
    handler: (async (ctx) => {
      try { return await made.handler(ctx); }
      finally { try { (baseStore as { setBusyTimeout?: (ms: number) => void }).setBusyTimeout?.(AFTER_OVERRIDE_STORE_BUSY_MS); } catch { /* keeps its wait */ } }
    }) as OverrideHandler,
  } : null;

  /** Close interrupted evaluations and queue what the queue never got, waiting briefly for locks. Never throws. */
  const repair = async (): Promise<void> => {
    if (!repairable) return;
    const set = (ms: number) => { try { (baseStore as { setBusyTimeout?: (ms: number) => void }).setBusyTimeout?.(ms); } catch { /* best effort */ } };
    set(REPAIR_BUSY_MS);
    try {
      if ((baseStore as { layoutCurrent?: () => boolean }).layoutCurrent?.() === false) return; // an older file: the agent or upkeep migrates it first
      await repairDelivery({ dir, store: repairable, queue: outbox ?? null, attester, connected: !!config.cloud });
    } catch { /* the next flush tries again */ }
    finally { set(STORE_BUSY_MS); }
  };

  return {
    gateway,
    agentKid: agent.kid,
    exporter,
    /** Why records are kept only in the local log this call (the delivery queue could not be opened), or null. */
    deliveryUnavailable,
    /** Close interrupted evaluations and queue receipts the queue never got (`flush` runs this first). */
    repair,
    /** Deliver queued receipts to Cloud with a bounded timeout, then it is safe to
     *  exit. Undelivered receipts persist in the durable outbox for the next run. */
    async flush(): Promise<void> {
      await repair();
      if (!exporter) return;
      const before = exporter.status().lastSuccessAt;
      const timeoutMs = config.cloud?.flushTimeoutMs ?? 3000;
      const cutOff = await flushBounded(exporter, timeoutMs, { routine: false });
      // The process exits after this call; keep what the attempt saw for `status` and `doctor`.
      // An attempt the time limit cut off has an outcome too: the exit abandons the request,
      // and a workspace slower than the limit used to leave only "last tried" moving, with no
      // error. A limit of 0 defers delivery on purpose (to a session-end `flush`).
      // A timeout is recorded only when the wait really ran out with a delivery under way.
      try { recordDeliveryAttempt(dirname(config.dbPath), exporter.status(), Date.now(), before, timeoutMs > 0 && cutOff ? timeoutMs : null, "hook"); } catch { /* diagnostic only */ }
    },
    /** Release the SQLite handles. The hook is a per-tool-call process, and a writer that
     *  exits without closing leaves its write-ahead log on disk for the next process to
     *  extend — measured at ~11 KiB of WAL per receipt against ~1.7 KiB when closed, so a
     *  busy session was writing tens of megabytes of pure overhead into the user's project.
     *  Always safe to call, and every exit path should. */
    close(): void {
      try { void Promise.resolve(baseStore.close?.()).catch(() => undefined); } catch { /* the decision is already recorded */ }
      try { outbox?.close(); } catch { /* best effort */ }
      try { boundary?.close(); } catch { /* best effort */ }
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
      // An action the coding agent reported only after it ran (Cursor's afterFileEdit) is signed as recorded after the
      // fact when a rule denies it: the receipt must not claim it was prevented.
      const options = { ...(override && !mapped.postHoc ? { override: override.handler } : {}), ...(mapped.postHoc ? { observedAfter: true } : {}) };
      const result = await gateway.handleAction({ intent: signed.intent, authorization: signed.authorization }, Object.keys(options).length ? options : undefined);
      const granted = (result.receipt as { payload?: { override?: { state?: string } } } | undefined)?.payload?.override;
      if (result.allowed && granted?.state === "offered") {
        return { decision: "ask", reason: "Scopebond: a workspace rule blocks this, and your workspace lets you allow it once. Allow only if you meant it; your answer is recorded.", receipt: result.receipt };
      }
      if (result.allowed) return { decision: "allow", reason: result.reason, receipt: result.receipt };
      // A deny is the one message the user and their agent actually read, so it is
      // composed from the deciding clause's own words rather than the engine's
      // internal reason ("param ref fails pattern").
      const clauseId = result.verdict?.clause_id ?? null;
      return {
        decision: "deny",
        reason: explainDeny({
          policy, clauseId, detail: result.reason,
          intent: signed.intent, policyPath: config.policyPath,
          postHoc: mapped.postHoc,
          // Point at the editable surface when there is one. `policy.json` is compiled
          // from `rules.json`, so telling someone to hand-edit it invites a change the
          // next `rules` run would overwrite.
          remedy: rulesRemedy,
        }) + (override?.hint() ? ` ${override.hint()}` : ""),
        clauseId,
        receipt: result.receipt,
      };
    },
    /** Decide a whole tool call. A shell call decomposes into several simple
     *  commands; every one is recorded, and a single deny denies the call. */
    async evaluate(mapped: Mapped | Mapped[], options: { groupKey?: string } = {}): Promise<Decision> {
      const raw = Array.isArray(mapped) ? mapped : [mapped];
      if (raw.length === 0) return { decision: "not_evaluated", reason: "no action", receipts: [] };
      // Every intent of one tool call carries one parent group id, so the receipts of a
      // decomposed call (a command, its file reads and writes, a rename destination)
      // link to each other and count once as an action. It is part of the signed
      // intent, so it is authenticated by the same signature as the rest.
      const scoped = scopeRoots.length ? applyRootScope(raw, { cwd: config.cwd ?? process.cwd(), roots: scopeRoots }) : raw;
      const list = withActionGroup(scoped, actionGroupId(options.groupKey));
      const receipts: unknown[] = [];
      const dispatched: NonNullable<Decision["dispatched"]> = [];
      let allow: Decision | null = null;
      let ask: Decision | null = null;
      let notEvaluated: Decision | null = null;
      for (const m of list) {
        const d = await this.evaluateOne(m);
        if (d.receipt !== undefined) receipts.push(d.receipt);
        dispatched.push({ action: { action_type: m.intent.action_type, params: m.intent.params }, ...(d.receipt !== undefined ? { receipt: d.receipt } : {}) });
        if (d.decision === "deny") return { ...d, receipts, dispatched };            // any deny denies the call
        if (d.decision === "allow" && !allow) allow = d;
        if (d.decision === "ask" && !ask) ask = d;
        if (d.decision === "not_evaluated" && !notEvaluated) notEvaluated = d;
      }
      // No deny: allow if any command was evaluated-and-allowed, else not_evaluated.
      // A command the person must be asked about makes the whole call an ask (warn mode); otherwise as before.
      const chosen = ask ?? allow ?? notEvaluated!;
      if (boundary) {
        // Immediately before permitted dispatch: approvals are consumed and the budget slot is reserved
        // atomically, once for the whole parent action, or nothing is spent and the call is denied.
        const group = String(list[0].intent.params[ACTION_GROUP_PARAM]);
        const delegation = process.env[DELEGATION_ENV] ?? "";
        const verdict = await boundary.authorize({
          actor: agent.kid, action_group: group, policy_digest: gateway.policyHash,
          intents: list.map((m) => dispatchIntentOf(m.intent as never)),
          ...(delegation !== "" ? { delegation_id: delegation } : {}),
        });
        if (!verdict.allow) {
          // Record the refusal as its own denied receipt, then deny the call.
          boundaryVerdict = verdict;
          try {
            const last = list[list.length - 1];
            const signed = agent.sign(last.intent);
            const result = await gateway.handleAction({ intent: signed.intent, authorization: signed.authorization });
            if (result.receipt !== undefined) receipts.push(result.receipt);
          } finally { boundaryVerdict = null; }
          return { decision: "deny", reason: `Scopebond blocked this before it ran: ${verdict.reason}${verdict.detail ? ` (${verdict.detail})` : ""}`, receipts, dispatched, dispatch: verdict };
        }
        return { ...chosen, receipts, dispatched, dispatch: verdict };
      }
      return { ...chosen, receipts, dispatched };
    },
  };
}
