// The hook's dispatch-boundary settings: single-use approvals, delegated child sessions
// and per-agent action budgets. They live in `dispatch.json` beside the policy, and the
// counters they spend live in `dispatch.db` in the same directory.
//
// Absent file, absent boundary: a hook with no `dispatch.json` and no delegated session
// behaves exactly as before. A file that is present but unreadable is an error, never a
// silent default, because it is the thing that says what may be spent.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { loadOrCreateHexKey, readBoundedIfPresent } from "./node-files.js";
import { createCloudDispatchSource, CLOUD_DISPATCH_SCOPE, type CloudDispatchSource } from "./dispatch-cloud.js";
import { createDispatchGuard, DISPATCH_DB } from "./dispatch-store.js";
import { StaticPrincipalKeyRegistry } from "./auth.js";
import { dispatchApprovalBinding, requestHash, validateBudgetPolicy, type ActionBudgetPolicy, type DispatchGuard } from "./dispatch.js";

export const DISPATCH_FILE = "dispatch.json";
export const APPROVAL_INBOX = "approvals";
export const DELEGATION_ENV = "SCOPEBOND_DELEGATION";
/** The installation-local secret the hook already uses for opaque ids. The dispatch boundary derives its own target ids from it. */
export const BINDING_KEY_FILE = "observation-binding" + ".key";
export const TARGET_ID_DOMAIN = "scopebond:dispatch-target/v1\n";
const MAX_FILE_BYTES = 256 * 1024;
const MAX_INBOX = 64;

export interface DispatchFile {
  /** Action types that need a single-use approval before dispatch; `*` for every action. */
  require_approval?: string[];
  /** Keys that may approve, by key id. */
  approver_keys?: Array<{ kid: string; public_key_pem: string }>;
  /** A lifetime shorter than the five-minute maximum. */
  approval_max_lifetime_seconds?: number;
  budgets?: ActionBudgetPolicy[];
  /** Set false to keep approvals and delegations local even when this machine is connected to a workspace. */
  cloud?: boolean;
}

export function readDispatchFile(dir: string): DispatchFile | null {
  const text = readBoundedIfPresent(join(dir, DISPATCH_FILE), MAX_FILE_BYTES, () => { throw new Error(`${DISPATCH_FILE} is larger than ${MAX_FILE_BYTES} bytes`); });
  if (text === undefined) return null;
  const raw = JSON.parse(text) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${DISPATCH_FILE} must be a JSON object`);
  const f = raw as DispatchFile;
  for (const b of f.budgets ?? []) if (!validateBudgetPolicy(b)) throw new Error(`${DISPATCH_FILE} holds an invalid budget policy`);
  if (f.require_approval !== undefined && (!Array.isArray(f.require_approval) || f.require_approval.some((t) => typeof t !== "string"))) throw new Error(`${DISPATCH_FILE}: require_approval must be a list of action types`);
  return f;
}

/** Approvals a person left for this hook: one JSON file each, in `approvals/`. Unreadable files are skipped, never trusted. */
export function readApprovalInbox(dir: string): unknown[] {
  const inbox = join(dir, APPROVAL_INBOX);
  let names: string[];
  try { names = readdirSync(inbox); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const out: unknown[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).slice(0, MAX_INBOX)) {
    try {
      // Size-checked on the open file, so the approval that passed the check is the one read.
      const text = readBoundedIfPresent(join(inbox, name), 16 * 1024, () => undefined);
      if (text === undefined) continue;
      out.push(JSON.parse(text));
    } catch { /* an unreadable approval approves nothing */ }
  }
  return out;
}

/** An opaque id for a target, so a path or ref never leaves the machine. Stable across processes; created (0600) when absent. */
export function targetIdFor(dir: string): (target: string) => string {
  const key = Buffer.from(loadOrCreateHexKey(join(dir, BINDING_KEY_FILE)), "hex");
  return (target) => `sbt_${createHmac("sha256", key).update(TARGET_ID_DOMAIN + target, "utf8").digest("hex").slice(0, 32)}`;
}

/** The workspace source for this machine, when it is connected with the grant the calls need. Otherwise null and everything stays local. */
export function openCloudSource(dir: string, options: { fetch?: typeof fetch; timeoutMs?: number } = {}): CloudDispatchSource | null {
  try {
    const c = JSON.parse(readFileSync(join(dir, "cloud.json"), "utf8")) as { url?: unknown; credential?: unknown; scopes?: unknown };
    if (typeof c.url !== "string" || typeof c.credential !== "string" || !Array.isArray(c.scopes) || !c.scopes.includes(CLOUD_DISPATCH_SCOPE)) return null;
    return createCloudDispatchSource({ url: c.url, credential: c.credential, targetId: targetIdFor(dir), ...options });
  } catch { return null; }
}

/** The guard for this hook, or null when nothing is configured. An independent hook is
 *  outbound-only, so it never claims a shared in-path gateway. */
export function openDispatchGuard(dir: string, options: { delegated?: boolean; cloud?: CloudDispatchSource | null; fetch?: typeof fetch } = {}): (DispatchGuard & { close(): void }) | null {
  const file = readDispatchFile(dir);
  if (!file && !(options.delegated ?? (process.env[DELEGATION_ENV] ?? "") !== "")) return null;
  const records = (file?.approver_keys ?? []).map((k) => ({ kid: k.kid, publicKeyPem: k.public_key_pem, purposes: ["approver" as const], status: "active" as const }));
  const cloud = options.cloud !== undefined ? options.cloud : file?.cloud === false ? null : openCloudSource(dir, { fetch: options.fetch });
  return createDispatchGuard({
    ...(cloud ? { cloud } : {}),
    dbPath: join(dir, DISPATCH_DB),
    keys: new StaticPrincipalKeyRegistry(records),
    requireApproval: file?.require_approval,
    approvals: () => readApprovalInbox(dir),
    approvalMaxLifetimeMs: file?.approval_max_lifetime_seconds ? file.approval_max_lifetime_seconds * 1000 : undefined,
    // Re-read each call, so a withdrawn or replaced policy takes effect on the next action.
    budgets: () => readDispatchFile(dir)?.budgets ?? [],
    sharedGatewayConfigured: false,
  });
}

/** Adds to a typed operation what lets the workspace correlate a consumed approval to it: `approval_request_hash` (the hash the guard asks the workspace to consume)
 *  and a `resource_id` equal to the guard's `target_id`. Only for an action type this installation requires an approval for, only when approvals may be held in
 *  the workspace; every other operation is returned as it was. The claim authorizes nothing: only a consumed approval in the workspace does. */
export interface ApprovalBinder {
  bind<T extends Record<string, unknown>>(operation: T, intent: { action_type: string; params?: Record<string, unknown>; asset?: string; amount?: number }): T;
  /** The same for a guard intent an adapter built itself (an MCP proxy hashes its own request): the exact `{ action_type, target, request }` it passes to the guard. */
  bindDispatched<T extends Record<string, unknown>>(operation: T, intent: { action_type: string; target: string; request: unknown }): T;
}

export function openApprovalBinder(dir: string): ApprovalBinder | null {
  let file: DispatchFile | null;
  try { file = readDispatchFile(dir); } catch { return null; }
  if (!file || file.cloud === false || !file.require_approval?.length) return null;
  const required = file.require_approval;
  let targetId: ((t: string) => string) | undefined;
  return {
    bind(operation, intent) {
      if (!required.some((t) => t === "*" || t === intent.action_type)) return operation;
      try {
        const b = dispatchApprovalBinding(intent);
        targetId ??= targetIdFor(dir);
        return { ...operation, approval_request_hash: b.request_hash, resource_id: targetId(b.target) };
      } catch { return operation; }
    },
    bindDispatched(operation, intent) {
      if (!required.some((t) => t === "*" || t === intent.action_type)) return operation;
      try {
        targetId ??= targetIdFor(dir);
        return { ...operation, approval_request_hash: requestHash(intent.request), resource_id: targetId(intent.target) };
      } catch { return operation; }
    },
  };
}
