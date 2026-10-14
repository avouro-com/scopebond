// Shared by the tray tests: a computer whose workspace lets a person act on some blocks, actions run through the hook as a
// coding tool would, and an agent serving it.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffold, createHookRuntime, mapClaudeToolUse, createOverrideHandler, compileManaged, defaultRules, digestRules, MANAGED_DOC_FILE } from "@scopebond/hook";
import { startService } from "../dist/index.js";

const ENFORCE = { enforce: ["protect-branches", "safe-shell", "protect-write", "protect-read"] };
const terms = (extra = {}) => ({ reason_min: 12, minutes: 0, daily_limit: 5, harness_prompt: false, ...extra });

/** A computer whose workspace lets a person allow destructive commands (or ask), and blocks reading secrets outright. */
export function computer(rules = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sb-tray-blocks-"));
  const { agentKid } = scaffold(dir, ENFORCE);
  const all = {
    "force-push-protected": { mode: "block" }, "push-protected": { mode: "block" },
    "destructive-shell": { mode: "override", override: terms({ always: "needs_admin", always_days: 14, requests: true }) },
    "secret-read": { mode: "block" }, "ci-config-write": { mode: "block" }, "network-egress": { mode: "monitor" }, ...rules,
  };
  const doc = { type: "scopebond:managed-rules", version: 1, revision: 2, export_id: "rev-2", environment_id: "env-1", agent_id: "agent-1",
    installation_id: "gw-1", rules: all, rules_digest: digestRules(all) };
  writeFileSync(join(dir, MANAGED_DOC_FILE), JSON.stringify(doc));
  writeFileSync(join(dir, "policy.json"), JSON.stringify(compileManaged(defaultRules(), doc, agentKid)));
  return dir;
}

/** Run tool calls through the hook as Claude Code in a checkout of acme/checkout; the window is not there, so each block is
 *  kept for the tray. */
export async function blockActions(dir, toolUses) {
  const runtime = createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cwd: "/repo",
    context: { harness: "claude", repository: "github.com/acme/checkout" },
    override: (agentKid) => {
      const made = createOverrideHandler({ dir, home: dir, agentKid, harness: "claude", waitMs: 50, ask: async () => ({ decision: "unavailable" }) });
      return made ? { handler: made.handler, hint: () => null } : null;
    },
  });
  try {
    for (const use of toolUses) await runtime.evaluate(mapClaudeToolUse({ cwd: "/repo", ...use }));
  } finally { runtime.close(); }
}

export const serviceFor = (dir, extra = {}) => startService({ dir, intervalMs: 60 * 60_000, log: () => {}, maintenance: false, tray: false,
  installKind: "npm", autoSignIn: false, migrate: false, ...extra });
