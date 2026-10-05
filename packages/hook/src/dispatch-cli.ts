// `scopebond budget` and `scopebond delegation`: manage the dispatch boundary's local settings.
//
// These change what an agent may do, so they belong to a person at a terminal. The caller
// refuses them without a TTY or `--yes`, the same as `init` and `trust`.
//
//   budget init [--actor kid] [--ops a,b]   write the 100 per 60 seconds monitor-only template
//   budget status                           each policy, its state and the current count
//   budget ack <budget-id>                  accept a policy exactly as written
//   delegation add <file.json>              register a delegation (a root, or a child of one)
//   delegation list                         every delegation and whether it is revoked
//   delegation revoke <id>                  revoke one and, by chain, everything below it
//   delegation import <file.json>           add revoked ids exported from the workspace

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DispatchStore, DISPATCH_DB, DISPATCH_FILE, readDispatchFile } from "@scopebond/gateway/node";
import { budgetAcknowledged, budgetDigest, defaultBudgetTemplate, scopeDigest, type ActionBudgetPolicy, type DelegatedScope } from "@scopebond/gateway";

function writeSettings(dir: string, next: Record<string, unknown>): void {
  writeFileSync(join(dir, DISPATCH_FILE), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

export function runDispatchCommand(kind: "budget" | "delegation", args: string[], dir: string, agentKid: string): number {
  const [sub, ...rest] = args;
  const flag = (name: string): string | undefined => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  if (kind === "budget") {
    const current = readDispatchFile(dir) ?? {};
    if (sub === "init") {
      const actor = flag("--actor") ?? agentKid;
      const ops = (flag("--ops") ?? "shell.exec,file.write,git.push,mcp.tool.call,net.fetch").split(",").filter(Boolean);
      const template = defaultBudgetTemplate(actor, ops);
      if ((current.budgets ?? []).some((b) => b.budget_id === template.budget_id)) { console.log(`A budget for ${actor} over these operations already exists.`); return 0; }
      writeSettings(dir, { ...current, budgets: [...(current.budgets ?? []), template] });
      console.log(`Wrote a monitor-only budget: ${template.max} dispatches in ${template.window_seconds}s for ${actor}.`);
      console.log(`Nothing is limited. To enforce it, edit "mode" to "enforce" in ${join(dir, DISPATCH_FILE)}, then run \`budget ack ${template.budget_id}\`.`);
      return 0;
    }
    if (sub === "ack") {
      const id = rest[0];
      const budgets = current.budgets ?? [];
      const policy = budgets.find((b) => b.budget_id === id);
      if (!policy) { console.error(`no budget ${id ?? ""}`); return 1; }
      const acknowledged: ActionBudgetPolicy = { ...policy, acknowledgement: { digest: budgetDigest(policy), acknowledged_at: new Date().toISOString() } };
      writeSettings(dir, { ...current, budgets: budgets.map((b) => (b.budget_id === id ? acknowledged : b)) });
      console.log(`Acknowledged ${id} at digest ${budgetDigest(policy).slice(0, 12)} (${policy.mode}). Any later edit to it needs a new acknowledgement.`);
      return 0;
    }
    if (sub === "status") {
      const budgets = current.budgets ?? [];
      if (budgets.length === 0) { console.log("No action budgets are configured."); return 0; }
      const db = existsSync(join(dir, DISPATCH_DB)) ? new DispatchStore(join(dir, DISPATCH_DB)) : null;
      try {
        for (const b of budgets) {
          const used = db ? db.budgetCount(b.budget_id, b.window_seconds).count : 0;
          const state = b.revoked ? "withdrawn" : Date.parse(b.expires_at) <= Date.now() ? "expired" : budgetAcknowledged(b) ? "acknowledged" : "not acknowledged";
          const scope = b.authority_scope === "shared_gateway" ? "shared gateway (an independent hook cannot enforce this)" : "this installation only";
          console.log(`${b.budget_id}  ${b.mode}  ${used}/${b.max} in ${b.window_seconds}s  ${state}  ${scope}`);
        }
      } finally { db?.close(); }
      return 0;
    }
    console.error("usage: budget init|ack <id>|status");
    return 1;
  }

  const store = new DispatchStore(join(dir, DISPATCH_DB));
  try {
    if (sub === "list") {
      const all = store.listDelegations();
      if (all.length === 0) console.log("No delegations are registered.");
      for (const d of all) console.log(`${d.delegation_id}  actor ${d.actor}  parent ${d.parent_id ?? "(root)"}  until ${d.expires_at}${d.revoked ? "  REVOKED" : ""}`);
      return 0;
    }
    if (sub === "revoke") {
      if (!rest[0]) { console.error("usage: delegation revoke <id>"); return 1; }
      store.revoke(rest[0]);
      console.log(`Revoked ${rest[0]}; every session below it is refused from the next action.`);
      return 0;
    }
    if (sub === "import") {
      if (!rest[0]) { console.error("usage: delegation import <revocations.json>"); return 1; }
      const raw = JSON.parse(readFileSync(rest[0], "utf8")) as unknown;
      const ids = Array.isArray(raw) ? raw : (raw as { revoked?: unknown })?.revoked;
      if (!Array.isArray(ids)) { console.error("the file must be a list of ids or { \"revoked\": [ids] }"); return 1; }
      console.log(`Imported ${store.importRevocations(ids as string[])} new revocation(s).`);
      return 0;
    }
    if (sub === "add") {
      if (!rest[0]) { console.error("usage: delegation add <delegation.json>  ({ delegation_id, parent_id, actor, scope, expires_at })"); return 1; }
      const input = JSON.parse(readFileSync(rest[0], "utf8")) as { scope: DelegatedScope; issued_at?: string; [k: string]: unknown };
      const result = store.addDelegation({ ...input, scope_digest: scopeDigest(input.scope), issued_at: input.issued_at ?? new Date().toISOString() });
      if (!result.ok) { console.error(`refused: ${result.problem}`); return 1; }
      console.log("Registered.");
      return 0;
    }
    console.error("usage: delegation add <file>|list|revoke <id>|import <file>");
    return 1;
  } finally { store.close(); }
}
