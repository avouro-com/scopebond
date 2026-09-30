// The hook's dispatch-boundary settings: single-use approvals, delegated child sessions
// and per-agent action budgets. They live in `dispatch.json` beside the policy, and the
// counters they spend live in `dispatch.db` in the same directory.
//
// Absent file, absent boundary: a hook with no `dispatch.json` and no delegated session
// behaves exactly as before. A file that is present but unreadable is an error, never a
// silent default, because it is the thing that says what may be spent.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createDispatchGuard, DISPATCH_DB } from "./dispatch-store.js";
import { StaticPrincipalKeyRegistry } from "./auth.js";
import { validateBudgetPolicy, type ActionBudgetPolicy, type DispatchGuard } from "./dispatch.js";

export const DISPATCH_FILE = "dispatch.json";
export const APPROVAL_INBOX = "approvals";
export const DELEGATION_ENV = "SCOPEBOND_DELEGATION";
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
}

export function readDispatchFile(dir: string): DispatchFile | null {
  const file = join(dir, DISPATCH_FILE);
  if (!existsSync(file)) return null;
  if (statSync(file).size > MAX_FILE_BYTES) throw new Error(`${DISPATCH_FILE} is larger than ${MAX_FILE_BYTES} bytes`);
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${DISPATCH_FILE} must be a JSON object`);
  const f = raw as DispatchFile;
  for (const b of f.budgets ?? []) if (!validateBudgetPolicy(b)) throw new Error(`${DISPATCH_FILE} holds an invalid budget policy`);
  if (f.require_approval !== undefined && (!Array.isArray(f.require_approval) || f.require_approval.some((t) => typeof t !== "string"))) throw new Error(`${DISPATCH_FILE}: require_approval must be a list of action types`);
  return f;
}

/** Approvals a person left for this hook: one JSON file each, in `approvals/`. Unreadable files are skipped, never trusted. */
export function readApprovalInbox(dir: string): unknown[] {
  const inbox = join(dir, APPROVAL_INBOX);
  if (!existsSync(inbox)) return [];
  const out: unknown[] = [];
  for (const name of readdirSync(inbox).filter((n) => n.endsWith(".json")).slice(0, MAX_INBOX)) {
    try {
      const file = join(inbox, name);
      if (statSync(file).size > 16 * 1024) continue;
      out.push(JSON.parse(readFileSync(file, "utf8")));
    } catch { /* an unreadable approval approves nothing */ }
  }
  return out;
}

/** The guard for this hook, or null when nothing is configured. An independent hook is
 *  outbound-only, so it never claims a shared in-path gateway. */
export function openDispatchGuard(dir: string, options: { delegated?: boolean } = {}): (DispatchGuard & { close(): void }) | null {
  const file = readDispatchFile(dir);
  if (!file && !(options.delegated ?? (process.env[DELEGATION_ENV] ?? "") !== "")) return null;
  const records = (file?.approver_keys ?? []).map((k) => ({ kid: k.kid, publicKeyPem: k.public_key_pem, purposes: ["approver" as const], status: "active" as const }));
  return createDispatchGuard({
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
