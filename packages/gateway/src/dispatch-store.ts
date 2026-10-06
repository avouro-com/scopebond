// The durable side of the dispatch boundary: one SQLite file that every hook process,
// proxy and gateway on this machine shares. A decision that spends something (an
// approval, a budget slot) is made inside ONE `BEGIN IMMEDIATE` transaction together with
// the checks that could refuse it, so two processes racing for the last slot or the same
// approval cannot both win, and a refusal leaves nothing spent.
//
// Time: wall clocks can be set backwards. The store keeps the highest time it has ever
// seen and never lets a decision use an earlier one, so rolling the clock back cannot
// revive an expired approval or delegation or reopen a full budget window. Where a budget is
// enforcing, a clock behind that mark denies until it catches up.

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PrincipalKeyRegistry } from "./auth.js";
import type { CloudDelegation, CloudDispatchSource, ConsumeAnswer } from "./dispatch-cloud.js";
import {
  actionInScope, actionScopeEntries, budgetAcknowledged, budgetDigest, checkApproval, isSubScope, requestHash, scopeDigest, validateDelegation,
  MAX_DELEGATION_DEPTH,
  type ActionBudgetPolicy, type BudgetObservation, type Delegation, type DelegationProblem, type DispatchApproval, type DispatchDecision,
  type DispatchGuard, type DispatchReason, type DispatchRequest,
} from "./dispatch.js";

type Statement = { run(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown };
type Db = { exec(sql: string): void; prepare(sql: string): Statement; close(): void };

export const DISPATCH_DB = "dispatch.db";
/** How far behind its own high-water mark the clock may read before it counts as rolled back. */
export const CLOCK_TOLERANCE_MS = 2_000;

function open(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (p: string) => Db };
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 15000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  return db;
}

export class DispatchStore {
  private readonly db: Db;

  constructor(readonly path: string, private readonly now: () => number = Date.now) {
    this.db = open(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS approval_consumptions (
        approval_id TEXT PRIMARY KEY, actor TEXT NOT NULL, action_type TEXT NOT NULL, request_hash TEXT NOT NULL,
        action_group TEXT NOT NULL, consumed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delegations (
        delegation_id TEXT PRIMARY KEY, parent_id TEXT, actor TEXT NOT NULL, scope_json TEXT NOT NULL,
        scope_digest TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delegation_cache (session_id TEXT PRIMARY KEY, body TEXT NOT NULL, fetched_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS revocations (delegation_id TEXT PRIMARY KEY, revoked_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS budget_reservations (
        budget_id TEXT NOT NULL, action_group TEXT NOT NULL, reserved_at INTEGER NOT NULL, policy_version INTEGER NOT NULL,
        PRIMARY KEY (budget_id, action_group)
      );
      CREATE INDEX IF NOT EXISTS budget_reservations_time ON budget_reservations (budget_id, reserved_at);
    `);
  }

  close(): void { try { this.db.close(); } catch { /* already closed */ } }

  /** Run `fn` inside one write transaction. It commits unless `fn` returns `{ commit: false }` or throws. */
  transaction<T>(fn: () => { commit: boolean; value: T }): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const { commit, value } = fn();
      this.db.exec(commit ? "COMMIT" : "ROLLBACK");
      return value;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* the original error matters */ }
      throw error;
    }
  }

  /** The clock as decisions must see it: never earlier than the highest time seen. */
  effectiveNow(): { now: number; rolledBack: boolean } {
    const wall = this.now();
    const row = this.db.prepare("SELECT v FROM meta WHERE k = 'high_water'").get() as { v: number } | undefined;
    const high = row?.v ?? 0;
    const rolledBack = wall < high - CLOCK_TOLERANCE_MS;
    const eff = Math.max(wall, high);
    if (eff > high) this.db.prepare("INSERT INTO meta (k, v) VALUES ('high_water', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(eff);
    return { now: eff, rolledBack };
  }

  // ── Delegation ──

  private delegation(id: string): (Delegation & { revoked: boolean }) | null {
    const row = this.db.prepare("SELECT * FROM delegations WHERE delegation_id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const revoked = this.db.prepare("SELECT 1 AS x FROM revocations WHERE delegation_id = ?").get(id) !== undefined;
    return {
      delegation_id: String(row.delegation_id), parent_id: row.parent_id === null ? null : String(row.parent_id), actor: String(row.actor),
      scope: JSON.parse(String(row.scope_json)), scope_digest: String(row.scope_digest),
      issued_at: new Date(Number(row.issued_at)).toISOString(), expires_at: new Date(Number(row.expires_at)).toISOString(), revoked,
    };
  }

  /** Register a delegation. A child must be a subset of its parent's scope and end no later than
   *  the parent; the parent must exist, be current and not be revoked. A root has no parent. */
  addDelegation(input: unknown): { ok: true } | { ok: false; problem: DelegationProblem } {
    if (!validateDelegation(input)) return { ok: false, problem: "malformed" };
    const d = input;
    if (scopeDigest(d.scope) !== d.scope_digest) return { ok: false, problem: "digest_mismatch" };
    return this.transaction<{ ok: true } | { ok: false; problem: DelegationProblem }>(() => {
      const { now } = this.effectiveNow();
      if (Date.parse(d.expires_at) <= now) return { commit: false, value: { ok: false, problem: "expired" } };
      if (this.delegation(d.delegation_id)) return { commit: false, value: { ok: false, problem: "already_exists" } };
      if (d.parent_id !== null) {
        const parent = this.delegation(d.parent_id);
        if (!parent) return { commit: false, value: { ok: false, problem: "unknown_parent" } };
        if (parent.revoked) return { commit: false, value: { ok: false, problem: "parent_revoked" } };
        if (Date.parse(parent.expires_at) <= now) return { commit: false, value: { ok: false, problem: "parent_expired" } };
        if (!isSubScope(d.scope, parent.scope)) return { commit: false, value: { ok: false, problem: "not_subset" } };
        if (Date.parse(d.expires_at) > Date.parse(parent.expires_at)) return { commit: false, value: { ok: false, problem: "outlives_parent" } };
      }
      this.db.prepare("INSERT INTO delegations (delegation_id,parent_id,actor,scope_json,scope_digest,issued_at,expires_at) VALUES (?,?,?,?,?,?,?)")
        .run(d.delegation_id, d.parent_id, d.actor, JSON.stringify(d.scope), d.scope_digest, Date.parse(d.issued_at), Date.parse(d.expires_at));
      return { commit: true, value: { ok: true } };
    });
  }

  hasDelegation(id: string): boolean { return this.delegation(id) !== null; }

  /** The workspace's resolved delegation for a session, when it was fetched no longer than `ttlMs` ago. Only an active grant is ever stored. */
  cachedDelegation(sessionId: string, now: number, ttlMs: number): CloudDelegation | null {
    const row = this.db.prepare("SELECT body, fetched_at FROM delegation_cache WHERE session_id = ?").get(sessionId) as { body: string; fetched_at: number } | undefined;
    if (!row || now < row.fetched_at || now - row.fetched_at > ttlMs) return null;
    try { return JSON.parse(row.body) as CloudDelegation; } catch { return null; }
  }

  putCachedDelegation(sessionId: string, delegation: CloudDelegation, now: number): void {
    this.db.prepare("INSERT INTO delegation_cache (session_id, body, fetched_at) VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at")
      .run(sessionId, JSON.stringify(delegation), now);
  }

  dropCachedDelegation(sessionId: string): void { this.db.prepare("DELETE FROM delegation_cache WHERE session_id = ?").run(sessionId); }

  /** Revoke a delegation and, through the chain walk on every check, everything below it. */
  revoke(id: string): void {
    this.db.prepare("INSERT INTO revocations (delegation_id, revoked_at) VALUES (?, ?) ON CONFLICT(delegation_id) DO NOTHING").run(id, this.now());
  }

  /** Add a list of revoked ids from elsewhere (a file exported from the workspace). Add-only:
   *  nothing here un-revokes. Returns how many were new. */
  importRevocations(ids: string[]): number {
    let added = 0;
    this.transaction(() => {
      for (const id of ids) {
        if (typeof id !== "string" || id === "") continue;
        if (!this.db.prepare("SELECT 1 AS x FROM revocations WHERE delegation_id = ?").get(id)) added++;
        this.db.prepare("INSERT INTO revocations (delegation_id, revoked_at) VALUES (?, ?) ON CONFLICT(delegation_id) DO NOTHING").run(id, this.now());
      }
      return { commit: true, value: undefined };
    });
    return added;
  }

  listDelegations(): Array<Delegation & { revoked: boolean }> {
    const rows = this.db.prepare("SELECT delegation_id FROM delegations ORDER BY issued_at").all() as Array<{ delegation_id: string }>;
    return rows.map((r) => this.delegation(r.delegation_id)!).filter(Boolean);
  }

  /** The current state of a delegation chain for one action; the checks every enforcement path runs. */
  checkDelegation(id: string, actor: string, now: number, intents: Array<{ action_type: string; target: string }>): DispatchReason | "ok" {
    let cursor: string | null = id;
    let leaf = true;
    for (let depth = 0; cursor !== null; depth++) {
      if (depth > MAX_DELEGATION_DEPTH) return "delegation_unknown";
      const d = this.delegation(cursor);
      if (!d) return "delegation_unknown";           // unknown ancestry never grants anything
      if (d.revoked) return "delegation_revoked";    // a revoked ancestor revokes every descendant
      if (Date.parse(d.expires_at) <= now) return "delegation_expired";
      if (leaf) {
        if (d.actor !== actor) return "delegation_wrong_actor";
        // Every ancestor's scope must also cover the action: a parent narrowed after the fact still binds its children.
        leaf = false;
      }
      if (!intents.every((i) => actionInScope(d.scope, i.action_type, i.target))) return "delegation_out_of_scope";
      cursor = d.parent_id;
    }
    return "ok";
  }

  // ── Budgets ──

  budgetCount(budgetId: string, windowSeconds: number): { count: number; now: number; rolledBack: boolean } {
    const { now, rolledBack } = this.effectiveNow();
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM budget_reservations WHERE budget_id = ? AND reserved_at > ?").get(budgetId, now - windowSeconds * 1000) as { n: number };
    return { count: Number(row.n), now, rolledBack };
  }

  /** Reserve the slot for one parent action inside the caller's transaction. */
  reserveBudget(policy: ActionBudgetPolicy, actionGroup: string, now: number): { repeated: boolean; count: number } {
    const existing = this.db.prepare("SELECT 1 AS x FROM budget_reservations WHERE budget_id = ? AND action_group = ?").get(policy.budget_id, actionGroup);
    const before = Number((this.db.prepare("SELECT COUNT(*) AS n FROM budget_reservations WHERE budget_id = ? AND reserved_at > ?").get(policy.budget_id, now - policy.window_seconds * 1000) as { n: number }).n);
    return { repeated: existing !== undefined, count: before };
  }

  insertReservation(policy: ActionBudgetPolicy, actionGroup: string, now: number): void {
    this.db.prepare("INSERT INTO budget_reservations (budget_id, action_group, reserved_at, policy_version) VALUES (?,?,?,?)").run(policy.budget_id, actionGroup, now, policy.version);
    // Old rows can no longer change a decision; keep the table bounded.
    this.db.prepare("DELETE FROM budget_reservations WHERE budget_id = ? AND reserved_at <= ?").run(policy.budget_id, now - Math.max(policy.window_seconds, 1) * 1000 * 2);
  }

  approvalConsumed(id: string): boolean {
    return this.db.prepare("SELECT 1 AS x FROM approval_consumptions WHERE approval_id = ?").get(id) !== undefined;
  }

  consumeApproval(a: DispatchApproval, actionGroup: string, now: number): void {
    this.db.prepare("INSERT INTO approval_consumptions (approval_id, actor, action_type, request_hash, action_group, consumed_at) VALUES (?,?,?,?,?,?)")
      .run(a.approval_id, a.actor, a.action_type, a.request_hash, actionGroup, now);
  }
}

// ── The guard ─────────────────────────────────────────────────────────────────

export interface DispatchGuardConfig {
  /** Path of the shared SQLite file (`dispatch.db`). */
  dbPath: string;
  /** Approver keys. Without them nothing can be approved, so an action needing approval is denied. */
  keys?: PrincipalKeyRegistry;
  /** Action types that need a single-use approval before dispatch; `*` means every action. */
  requireApproval?: string[];
  /** Candidate approvals presented for this call (read from an inbox by the caller). */
  approvals?: () => unknown[];
  /** Narrower approval lifetime than the five-minute maximum. */
  approvalMaxLifetimeMs?: number;
  /** The workspace as an approval and delegation source. Absent, only local approvals and delegations exist. */
  cloud?: CloudDispatchSource;
  /** How long a resolved workspace delegation may be reused before it is asked for again (default 15 seconds). A revocation is honoured within this. */
  delegationCacheMs?: number;
  /** The reviewed budget policies in force, re-read on each call so a withdrawal takes effect at once. */
  budgets?: () => ActionBudgetPolicy[];
  /** True only where this process is, or is behind, a customer-controlled shared in-path gateway that
   *  every dispatch for the agent passes through. Independent outbound-only hooks leave it false. */
  sharedGatewayConfigured?: boolean;
  now?: () => number;
}

const deny = (reason: DispatchReason, detail: string, budgets: BudgetObservation[] = []): DispatchDecision =>
  ({ allow: false, reason, detail, consumed_approvals: [], budgets });

/** Build the guard. `authorize` is called once per parent action, after every policy check has
 *  allowed it and immediately before it is dispatched. It either returns allow with the approvals
 *  consumed and the budget slots reserved, or denies having consumed nothing. */
export function createDispatchGuard(config: DispatchGuardConfig): DispatchGuard & { close(): void } {
  let store: DispatchStore | null = null;
  const nowFn = config.now ?? Date.now;
  const requires = (actionType: string): boolean => (config.requireApproval ?? []).some((t) => t === "*" || t === actionType);

  return {
    close(): void { store?.close(); store = null; },
    async authorize(req: DispatchRequest): Promise<DispatchDecision> {
      const policies = (config.budgets?.() ?? []).filter((p) => p.actor === req.actor && req.intents.some((i) => p.operations.includes(i.action_type)));
      const enforcing = policies.some((p) => p.mode === "enforce");
      const needsApproval = req.intents.some((i) => requires(i.action_type));
      const needsState = enforcing || needsApproval || req.delegation_id !== undefined || policies.length > 0;
      if (!needsState) return { allow: true, reason: "ok", consumed_approvals: [], budgets: [] };

      let db: DispatchStore;
      let approvalNow: number;
      try {
        db = store ??= new DispatchStore(config.dbPath, nowFn);
        // Judge lifetimes against the highest time this store has seen, so a clock set back revives nothing.
        approvalNow = db.effectiveNow().now;
      } catch (error) {
        return unavailable(policies, enforcing || needsApproval || req.delegation_id !== undefined, (error as Error).message);
      }
      // Approvals are checked (signature, binding, lifetime) before the transaction; their single use is decided inside it.
      const chosen = new Map<number, DispatchApproval>();
      const presented = needsApproval ? (config.approvals?.() ?? []) : [];
      // A reference to an approval held in the workspace is not a signed approval; the two never mix.
      const cloudRefs = presented.filter(isCloudApprovalRef).map((c) => c.cloud_approval_id);
      const candidates = presented.filter((c) => !isCloudApprovalRef(c));
      const cloudChosen = new Map<number, string>();
      let approvalFailure: { reason: DispatchReason; detail: string } | null = null;
      if (needsApproval) {
        for (let i = 0; i < req.intents.length; i++) {
          const intent = req.intents[i]!;
          if (!requires(intent.action_type)) continue;
          const subject = { actor: req.actor, action_type: intent.action_type, target: intent.target, policy_digest: req.policy_digest, request_hash: requestHash(intent.request) };
          let lastReject: string | null = null;
          for (const candidate of candidates) {
            if (!config.keys) break;
            const checked = await checkApproval(candidate, subject, config.keys, approvalNow, { maxLifetimeMs: config.approvalMaxLifetimeMs });
            if (checked.ok && ![...chosen.values()].some((c) => c.approval_id === checked.approval.approval_id)) { chosen.set(i, checked.approval); break; }
            if (!checked.ok) lastReject = checked.reason;
          }
          // The offline path is unchanged and is tried first; only when no local approval is valid is the workspace asked.
          if (!chosen.has(i) && config.cloud) {
            const ref = cloudRefs.find((id) => ![...cloudChosen.values()].includes(id));
            if (ref !== undefined) cloudChosen.set(i, ref);
          }
          // No hand-copied reference: ask the workspace whether an approval for exactly this request is active. Its id is only a candidate; the consume decides.
          let lookupNote = "";
          if (!chosen.has(i) && !cloudChosen.has(i) && config.cloud) {
            const found = await config.cloud.activeApproval({ request_hash: subject.request_hash, action_type: intent.action_type, target_id: config.cloud.targetId(intent.target) });
            if (found.ok && found.approval_id !== null && !cloudChosen.has(i) && ![...cloudChosen.values()].includes(found.approval_id)) cloudChosen.set(i, found.approval_id);
            else if (!found.ok) lookupNote = `; the workspace could not be asked for an active approval (${found.reason})`;
          }
          if (!chosen.has(i) && !cloudChosen.has(i)) {
            const hint = config.cloud ? `; to approve it in the workspace use request_hash ${subject.request_hash} and target_id ${config.cloud.targetId(intent.target)}${lookupNote}` : "";
            approvalFailure = candidates.length === 0 || !config.keys
              ? { reason: "approval_required", detail: `${intent.action_type} needs a single-use approval and none was presented${hint}` }
              : { reason: "approval_rejected", detail: `no presented approval is valid for this exact ${intent.action_type} (${lastReject ?? "no match"})${hint}` };
            break;
          }
        }
      }
      if (approvalFailure) return deny(approvalFailure.reason, approvalFailure.detail);

      // A delegation the local store does not know is asked of the workspace, when there is one. Unknown ancestry grants nothing.
      let workspaceDelegation = false;
      if (req.delegation_id !== undefined && config.cloud && !db.hasDelegation(req.delegation_id)) {
        workspaceDelegation = true;
        const verdict = await checkWorkspaceDelegation(db, config.cloud, req.delegation_id, req.intents, config.delegationCacheMs ?? DELEGATION_CACHE_MS);
        if (verdict) return deny(verdict.reason, verdict.detail);
      }

      const decide = (): { commit: boolean; value: DispatchDecision } => {
          const { now, rolledBack } = db.effectiveNow();
          if (req.delegation_id !== undefined && !workspaceDelegation) {
            const verdict = db.checkDelegation(req.delegation_id, req.actor, now, req.intents);
            if (verdict !== "ok") return { commit: false, value: deny(verdict, `the session delegation ${req.delegation_id} does not permit this action (${verdict})`) };
          }
          for (const [, a] of chosen) {
            if (Date.parse(a.expires_at) <= now) return { commit: false, value: deny("approval_rejected", "the approval expired") };
            if (db.approvalConsumed(a.approval_id)) return { commit: false, value: deny("approval_replayed", `approval ${a.approval_id} was already used`) };
          }
          const observations: BudgetObservation[] = [];
          const toInsert: ActionBudgetPolicy[] = [];
          for (const policy of policies) {
            const base = { budget_id: policy.budget_id, version: policy.version, mode: policy.mode, authority_scope: policy.authority_scope, max: policy.max, window_seconds: policy.window_seconds };
            const hard = policy.mode === "enforce";
            const refuse = (reason: DispatchReason, detail: string, state: BudgetObservation["state"]): DispatchDecision | null => {
              observations.push({ ...base, count: 0, state, repeated: false });
              return hard ? deny(reason, detail, observations) : null;
            };
            let refusal: DispatchDecision | null = null;
            if (policy.authority_scope === "shared_gateway" && !config.sharedGatewayConfigured) {
              refusal = refuse("budget_capability_unsupported", `budget ${policy.budget_id} needs a shared in-path gateway; independent hooks cannot enforce a limit shared across installations`, "unenforceable");
              if (refusal) return { commit: false, value: refusal };
              continue;
            }
            const problem: [DispatchReason, string] | null = policy.revoked ? ["budget_revoked", "the budget policy was withdrawn"]
              : Date.parse(policy.expires_at) <= now ? ["budget_expired", "the budget policy expired"]
              : !budgetAcknowledged(policy) ? ["budget_unacknowledged", `the budget policy has no acknowledgement of digest ${budgetDigest(policy).slice(0, 12)}`]
              : rolledBack ? ["clock_rollback", "the system clock is behind a time this counter already saw"] : null;
            if (problem) {
              refusal = refuse(problem[0], problem[1], "unenforceable");
              if (refusal) return { commit: false, value: refusal };
              continue;
            }
            const { repeated, count } = db.reserveBudget(policy, req.action_group, now);
            const after = repeated ? count : count + 1;
            const over = !repeated && count >= policy.max;
            observations.push({ ...base, count: over && hard ? count : after, state: over ? "over" : after === policy.max ? "at_limit" : "within", repeated });
            if (over && hard) return { commit: false, value: deny("budget_exceeded", `${policy.max} actions in ${policy.window_seconds}s already dispatched for this agent on this installation`, observations) };
            if (!repeated) toInsert.push(policy);
          }
          for (const p of toInsert) db.insertReservation(p, req.action_group, now);
          for (const [, a] of chosen) db.consumeApproval(a, req.action_group, now);
          return { commit: true, value: { allow: true, reason: "ok", consumed_approvals: [...chosen.values()].map((a) => a.approval_id), budgets: observations } };
      };

      try {
        const consumedInWorkspace: string[] = [];
        if (cloudChosen.size > 0 && config.cloud) {
          // Look before spending: a refusal by the delegation, a replay or a budget must not burn a person's approval.
          const dry = db.transaction<DispatchDecision>(() => ({ commit: false, value: decide().value }));
          if (!dry.allow) return dry;
          for (const [i, approvalId] of cloudChosen) {
            const intent = req.intents[i]!;
            const answer = await config.cloud.consume({
              approval_id: approvalId, request_hash: requestHash(intent.request), action_type: intent.action_type, policy_digest: req.policy_digest,
              target_id: config.cloud.targetId(intent.target), client_time: new Date(nowFn()).toISOString(),
            });
            if (!answer.ok) return deny(...workspaceRefusal(answer, intent.action_type, approvalId));
            consumedInWorkspace.push(approvalId);
          }
        }
        const decision = db.transaction<DispatchDecision>(decide);
        return consumedInWorkspace.length > 0 && decision.allow ? { ...decision, consumed_approvals: [...decision.consumed_approvals, ...consumedInWorkspace] } : decision;
      } catch (error) {
        return unavailable(policies, enforcing || needsApproval || req.delegation_id !== undefined, (error as Error).message);
      }
    },
  };
}

/** A person's approval held in the workspace, left in the inbox by id. It carries nothing that authorizes; the workspace decides. */
export const isCloudApprovalRef = (v: unknown): v is { cloud_approval_id: string } =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 &&
  typeof (v as { cloud_approval_id?: unknown }).cloud_approval_id === "string" && /^[\x21-\x7e]{1,100}$/.test((v as { cloud_approval_id: string }).cloud_approval_id);

export const DELEGATION_CACHE_MS = 15_000;

function workspaceRefusal(answer: Exclude<ConsumeAnswer, { ok: true }>, actionType: string, approvalId: string): [DispatchReason, string] {
  if (answer.reason === "unreachable") return ["approval_unavailable", `the workspace could not be reached to consume approval ${approvalId} for ${actionType}, and no valid local approval was presented (${answer.detail})`];
  if (answer.reason === "consumed") return ["approval_replayed", `approval ${approvalId} was already used`];
  return ["approval_rejected", `the workspace did not approve ${actionType} with ${approvalId} (${answer.reason === "server_refused" ? `status ${answer.status}` : answer.reason})`];
}

/** Whether a workspace-resolved delegation permits every intent, or why not. Asks the workspace unless a fresh answer is cached. */
async function checkWorkspaceDelegation(
  db: DispatchStore, cloud: CloudDispatchSource, sessionId: string, intents: Array<{ action_type: string; target: string }>, ttlMs: number,
): Promise<{ reason: DispatchReason; detail: string } | null> {
  const { now } = db.effectiveNow();
  let resolved = db.cachedDelegation(sessionId, now, ttlMs);
  // The workspace's own answer for the FIRST intent, when it gave one; every other intent is judged from the entries it listed.
  let covers: boolean | undefined;
  if (!resolved) {
    const first = intents[0];
    const answer = await cloud.delegation(sessionId, first ? { action_type: first.action_type, target_id: cloud.targetId(first.target) } : undefined);
    if (!answer.ok) {
      const why = answer.reason === "server_refused" ? `status ${answer.status}` : answer.detail;
      return { reason: "delegation_unknown", detail: `the session delegation ${sessionId} could not be resolved (${answer.reason}: ${why}); unknown ancestry grants nothing` };
    }
    resolved = answer.delegation;
    covers = answer.covers;
    db.dropCachedDelegation(sessionId);
    // Only an active grant is reused; a refusal is always asked again.
    if (resolved.state === "active" && resolved.grants) db.putCachedDelegation(sessionId, resolved, db.effectiveNow().now);
  }
  const state = resolved.state;
  if (state === "revoked") return { reason: "delegation_revoked", detail: `the session delegation ${sessionId} was revoked` };
  if (state === "expired" || state === "ended") return { reason: "delegation_expired", detail: `the session delegation ${sessionId} is ${state}` };
  if (state !== "active" || !resolved.grants) return { reason: "delegation_unknown", detail: `the session delegation ${sessionId} grants nothing (${state})` };
  if (resolved.effective_expires_at !== null && resolved.effective_expires_at <= now) return { reason: "delegation_expired", detail: `the session delegation ${sessionId} expired` };
  const held = new Set(resolved.effective_entries);
  for (const [n, i] of intents.entries()) {
    // Entries are over the opaque target id the workspace also receives, never the raw path or ref.
    let covered = false;
    if (n === 0 && covers !== undefined) covered = covers;
    else { try { const wanted = actionScopeEntries(i.action_type, cloud.targetId(i.target)); covered = held.has(wanted.exact) || held.has(wanted.anyTarget); } catch { covered = false; } }
    if (!covered) return { reason: "delegation_out_of_scope", detail: `the session delegation ${sessionId} does not cover ${i.action_type} on this target` };
  }
  return null;
}

function unavailable(policies: ActionBudgetPolicy[], mustDeny: boolean, detail: string): DispatchDecision {
  const budgets: BudgetObservation[] = policies.map((p) => ({
    budget_id: p.budget_id, version: p.version, mode: p.mode, authority_scope: p.authority_scope, count: 0, max: p.max, window_seconds: p.window_seconds,
    state: "unavailable", repeated: false,
  }));
  // An unreadable counter never means unlimited dispatch where anything is being enforced.
  if (mustDeny) return { allow: false, reason: "counter_unavailable", detail: `the dispatch counter could not be used (${detail})`, consumed_approvals: [], budgets };
  return { allow: true, reason: "ok", detail: "monitoring only: the counter was unavailable", consumed_approvals: [], budgets };
}
