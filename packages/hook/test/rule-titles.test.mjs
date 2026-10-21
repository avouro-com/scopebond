// The name a person reads for the rule behind a block. Every rule and clause the hook ships today has its own title: the
// always-on protections, the starter rules, the rules a workspace sets, blocked services, the target rules, a rule pack's
// rules, and the checks that refuse an action without a clause (Safe Install, session budgets, the dispatch check). The
// generic "A Scopebond rule" is only for a block nothing names.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blockTitle, GENERIC_RULE_TITLE, starterPolicy, compile, compileManaged, defaultRules, digestManaged, packRuleClauses, TARGET_RULES,
  noteBlock, readBlockNotes, setActivePacks,
} from "../dist/index.js";

const require = createRequire(import.meta.url);
const example = JSON.parse(readFileSync(require.resolve("@scopebond/policy-schema/vectors/example-pack.json"), "utf8"));

const EXPECTED = {
  // Scopebond's own protection (always on): named as the workspace names what it covers.
  "protect-scopebond-write": "Change Scopebond's or the agent's safety settings",
  "protect-scopebond-read": "Read passwords, keys or secrets",
  // The starter rules.
  "protect-branches": "Push straight to a protected branch",
  "safe-shell": "Run a command that deletes data or shuts down the computer",
  "protect-write": "Change build and release settings",
  "protect-read": "Read passwords, keys or secrets",
  "observe-net-mcp": "Contact websites or use MCP tools",
  "protect-root": "Change files outside the allowed folders",
  "protect-remote-database": "Run risky SQL on a remote database",
  "keys": "Act without this computer's enrolled key",
  // What a workspace adds.
  "protect-branch-history": "Rewrite history on a protected branch",
  "allowed-sites": "Contact websites and online services",
  "blocked-mcp-servers": "Use a blocked MCP server",
  "blocked-hosts": "Contact a blocked site",
  "blocked-programs": "Run a blocked program",
  "blocked-packages": "Install a blocked package",
  // The target rules a pack defines.
  "cloud-destructive": "Delete cloud resources or Kubernetes objects",
  "production-deploy": "Deploy to production",
  "secret-write": "Store or change a secret",
  "iam-change": "Change who can access what",
  "database-migrate": "Undo or reset a database migration",
  // A pack's own rules: its description's first sentence, else what its action types do.
  "example-destructive": "Deleting example resources",
  "example-deploy": "Deploy a release",
  // The checks that refuse an action without a clause.
  "safe-install": "Install a package Safe Install flagged",
  "session-budget": "Go past this session's limits",
  "dispatch-check": "Act without a needed approval or past an agent's budget",
};

/** Every clause id the hook produces today. */
function shippedClauseIds() {
  const ids = new Set();
  const add = (policy) => { for (const c of policy.clauses) ids.add(c.id); };
  add(starterPolicy("kid-1"));
  add(compile({ ...defaultRules(), allowed_roots: ["/w"], protect_remote_database: true }, "kid-1"));
  const rules = {
    "force-push-protected": { mode: "block" }, "push-protected": { mode: "monitor" }, "destructive-shell": { mode: "block" },
    "secret-read": { mode: "block" }, "ci-config-write": { mode: "block" }, "network-egress": { mode: "block", allowed_hosts: ["example.org"] },
  };
  const services = [{ kind: "cli", key: "ffmpeg" }, { kind: "host", key: "tracker.example.net" }, { kind: "mcp_server", key: "github" }, { kind: "package", key: "npm:zod" }];
  add(compileManaged(defaultRules(), {
    type: "scopebond:managed-rules", version: 1, revision: 3, export_id: "rev-3-gw", environment_id: "env-1", agent_id: "agent-1", installation_id: "gw",
    rules, blocked_services: services, rules_digest: digestManaged(rules, services),
  }, "kid-1"));
  for (const id of TARGET_RULES) ids.add(id);
  for (const c of packRuleClauses(new Set(), [example])) ids.add(c.id);
  for (const id of ["safe-install", "session-budget", "dispatch-check"]) ids.add(id);
  return [...ids].sort();
}

test("every clause id the hook ships has its own title, never the generic one", () => {
  setActivePacks([example]);
  try {
    const ids = shippedClauseIds();
    assert.deepEqual(ids, Object.keys(EXPECTED).sort(), "the list of shipped clauses changed: give the new one a title here");
    for (const id of ids) {
      const title = blockTitle(null, id);
      assert.notEqual(title, GENERIC_RULE_TITLE, id);
      assert.equal(title, EXPECTED[id], id);
    }
  } finally { setActivePacks([]); }
});

test("a pack rule's title: its description's first sentence, trimmed; else what its action types do", () => {
  const pack = structuredClone(example);
  pack.rules = [
    { id: "long", type: "action_allowlist", action_types: ["file.write"], description: "Deny writing the example tool's settings files under any of the folders it reads at start-up. More words here." },
    { id: "plain", type: "action_allowlist", action_types: ["secret.write"], description: "Store a secret in the example vault" },
    { id: "unknown-type", type: "action_allowlist", action_types: ["example.thing"] },
  ];
  setActivePacks([pack]);
  try {
    const long = blockTitle(null, "long");
    assert.ok(long.length <= 60, long);
    assert.match(long, /^Writing the example tool's settings files/);
    assert.equal(blockTitle(null, "plain"), "Store a secret in the example vault");
    assert.notEqual(blockTitle(null, "unknown-type"), GENERIC_RULE_TITLE);
  } finally { setActivePacks([]); }
  // Without the pack in force, its rule is no longer known.
  assert.equal(blockTitle(null, "plain"), GENERIC_RULE_TITLE);
});

test("a block note names the check that refused the call, and keeps a pack rule's title for the tray", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-titles-"));
  const receipt = (id) => ({ payload: { action_ref: { action_id: id } } });
  noteBlock(dir, { decision: "deny", clauseId: null, code: "install_verdict", receipt: receipt("a1") }, { harness: "claude", project: null });
  noteBlock(dir, { decision: "deny", code: "session_budget", receipts: [receipt("a2")] }, { harness: "claude", project: null });
  noteBlock(dir, { decision: "deny", code: "dispatch_refused", receipts: [receipt("a3")] }, { harness: "claude", project: null });
  setActivePacks([example]);
  try { noteBlock(dir, { decision: "deny", clauseId: "example-destructive", receipt: receipt("a4") }, { harness: "claude", project: null }); } finally { setActivePacks([]); }
  const notes = Object.fromEntries(readBlockNotes(dir).map((n) => [n.id, n]));
  assert.equal(notes.a1.clause, "safe-install");
  assert.equal(blockTitle(notes.a1.rule, notes.a1.clause), "Install a package Safe Install flagged");
  assert.equal(notes.a2.clause, "session-budget");
  assert.equal(notes.a3.clause, "dispatch-check");
  assert.equal(notes.a4.clause, "example-destructive");
  assert.equal(notes.a4.title, "Deleting example resources", "kept for a reader with no pack in force");
});
