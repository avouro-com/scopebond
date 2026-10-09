import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  budgetDigest, createGateway, deriveKid, dispatchIntentOf, requestHash, scopeDigest, signDispatchApproval, StaticPrincipalKeyRegistry,
  defaultBudgetTemplate, canonical, intentHash,
} from "../dist/index.js";
import { createDispatchGuard, DispatchStore } from "../dist/node.js";
import { sign as edSign } from "node:crypto";

const T0 = Date.parse("2026-09-30T12:00:00.000Z");
const dirOf = () => mkdtempSync(join(tmpdir(), "sb-dispatch-"));

function principal(purposes) {
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const raw = pair.publicKey.export({ format: "jwk" });
  return { kid: deriveKid({ crv: raw.crv, kty: raw.kty, x: raw.x }), publicKeyPem, privateKey: pair.privateKey, purposes };
}
const registry = (...ps) => new StaticPrincipalKeyRegistry(ps.map((p) => { const r = { ...p, status: "active" }; delete r.privateKey; return r; }));

/** A clock the test moves by hand. */
function clock(start = T0) { const c = { t: start, now: () => c.t }; return c; }

const iso = (ms) => new Date(ms).toISOString();
const intent = (over = {}) => dispatchIntentOf({ action_type: "git.push", params: { ref: "feature/x", action_group: "g" }, ...over });
const req = (over = {}) => ({ actor: "agent-1", action_group: "group-1", policy_digest: "pd-1", intents: [intent()], ...over });

function budget(over = {}) {
  const p = { ...defaultBudgetTemplate("agent-1", ["git.push", "shell.exec"], new Date(T0)), max: 3, window_seconds: 60, mode: "enforce", ...over };
  p.acknowledgement = over.acknowledgement === undefined ? { digest: budgetDigest(p), acknowledged_at: iso(T0) } : over.acknowledgement;
  return p;
}

// ── budgets ──────────────────────────────────────────────────────────────────

test("a budget allows up to max, then denies before dispatch; below, equal and above the maximum", async () => {
  const dir = dirOf(); const c = clock();
  const guard = createDispatchGuard({ dbPath: join(dir, "d.db"), budgets: () => [budget()], now: c.now });
  const seen = [];
  for (let i = 1; i <= 4; i++) seen.push(await guard.authorize(req({ action_group: `g${i}` })));
  assert.deepEqual(seen.map((d) => d.allow), [true, true, true, false]);
  assert.equal(seen[1].budgets[0].state, "within");
  assert.equal(seen[2].budgets[0].state, "at_limit", "equal to max is the last allowed dispatch");
  assert.equal(seen[3].reason, "budget_exceeded");
  guard.close();
});

test("the window slides: an old dispatch stops counting once its window has elapsed", async () => {
  const dir = dirOf(); const c = clock();
  const guard = createDispatchGuard({ dbPath: join(dir, "d.db"), budgets: () => [budget({ max: 1 })], now: c.now });
  assert.equal((await guard.authorize(req({ action_group: "a" }))).allow, true);
  c.t += 30_000;
  assert.equal((await guard.authorize(req({ action_group: "b" }))).allow, false);
  c.t += 31_000;
  assert.equal((await guard.authorize(req({ action_group: "c" }))).allow, true);
  guard.close();
});

test("one parent action counts once however many intents it maps to, and a retry of the same call does not count again", async () => {
  const dir = dirOf(); const c = clock();
  const guard = createDispatchGuard({ dbPath: join(dir, "d.db"), budgets: () => [budget({ max: 2 })], now: c.now });
  const many = req({ action_group: "one-call", intents: [intent(), intent({ params: { ref: "feature/y" } }), intent({ action_type: "shell.exec", params: { program: "git" } })] });
  assert.equal((await guard.authorize(many)).allow, true);
  const retry = await guard.authorize(many);
  assert.equal(retry.allow, true);
  assert.equal(retry.budgets[0].repeated, true);
  assert.equal(retry.budgets[0].count, 1, "the retry consumed nothing");
  assert.equal((await guard.authorize(req({ action_group: "new-invocation" }))).allow, true, "a new invocation takes the second slot");
  assert.equal((await guard.authorize(req({ action_group: "third" }))).allow, false);
  guard.close();
});

test("an action outside the operation set or another actor's action is not counted", async () => {
  const dir = dirOf(); const c = clock();
  const guard = createDispatchGuard({ dbPath: join(dir, "d.db"), budgets: () => [budget({ max: 1 })], now: c.now });
  for (let i = 0; i < 5; i++) {
    assert.equal((await guard.authorize(req({ action_group: `r${i}`, intents: [intent({ action_type: "file.read", params: { path: "a" } })] }))).allow, true);
    assert.equal((await guard.authorize(req({ action_group: `o${i}`, actor: "agent-2" }))).allow, true);
  }
  guard.close();
});

test("counters persist across processes: a new guard on the same file sees the earlier dispatches", async () => {
  const dir = dirOf(); const c = clock();
  const first = createDispatchGuard({ dbPath: join(dir, "d.db"), budgets: () => [budget({ max: 2 })], now: c.now });
  await first.authorize(req({ action_group: "a" })); await first.authorize(req({ action_group: "b" }));
  first.close();
  const restarted = createDispatchGuard({ dbPath: join(dir, "d.db"), budgets: () => [budget({ max: 2 })], now: c.now });
  assert.equal((await restarted.authorize(req({ action_group: "c" }))).allow, false, "a restart is not a reset");
  restarted.close();
});

test("a version bump or re-issue does not reset the counter", async () => {
  const dir = dirOf(); const c = clock();
  const v1 = budget({ max: 1 });
  const g1 = createDispatchGuard({ dbPath: join(dir, "d.db"), budgets: () => [v1], now: c.now });
  await g1.authorize(req({ action_group: "a" })); g1.close();
  const v2 = budget({ max: 1, version: 2, budget_id: v1.budget_id });
  const g2 = createDispatchGuard({ dbPath: join(dir, "d.db"), budgets: () => [v2], now: c.now });
  assert.equal((await g2.authorize(req({ action_group: "b" }))).allow, false);
  g2.close();
});

test("concurrent reservations from separate processes never exceed the maximum", async () => {
  const dir = dirOf();
  const db = join(dir, "d.db");
  new DispatchStore(db).close(); // create the schema once
  const policy = budget({ max: 5, window_seconds: 3600, budget_id: "budget:concurrent-0001", expires_at: "2099-01-01T00:00:00.000Z" });
  const script = `
    import { createDispatchGuard } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../dist/node.js")).href)};
    const policy = ${JSON.stringify(policy)};
    const g = createDispatchGuard({ dbPath: ${JSON.stringify(db)}, budgets: () => [policy] });
    const d = await g.authorize({ actor: "agent-1", action_group: process.argv[1], policy_digest: "p", intents: [{ action_type: "git.push", target: "t", request: {} }] });
    console.log(d.allow ? "allow" : d.reason);
    g.close();
  `;
  const run = (i) => new Promise((resolve, reject) => execFile(process.execPath, ["--input-type=module", "-e", script, `group-${i}`], (e, out, err) => e ? reject(new Error(err || e.message)) : resolve(out.trim())));
  const outcomes = await Promise.all(Array.from({ length: 12 }, (_, i) => run(i)));
  const allowed = outcomes.filter((o) => o === "allow").length;
  assert.equal(allowed, 5, `exactly max dispatches were allowed, got ${JSON.stringify(outcomes)}`);
  assert.equal(outcomes.filter((o) => o === "budget_exceeded").length, 7);
});

test("enforcement fails closed: unacknowledged, changed-after-acknowledgement, expired and withdrawn policies deny", async () => {
  const c = clock();
  const cases = [
    ["budget_unacknowledged", budget({ acknowledgement: null })],
    ["budget_unacknowledged", { ...budget(), max: 999 }],
    ["budget_expired", budget({ expires_at: iso(T0 - 1) })],
    ["budget_revoked", { ...budget(), revoked: true }],
  ];
  for (const [reason, policy] of cases) {
    const dir = dirOf();
    const guard = createDispatchGuard({ dbPath: join(dir, "d.db"), budgets: () => [policy], now: c.now });
    const decision = await guard.authorize(req());
    assert.equal(decision.allow, false, reason);
    assert.equal(decision.reason, reason);
    guard.close();
  }
});

test("monitor mode never denies, records the excess, and still counts", async () => {
  const dir = dirOf(); const c = clock();
  const guard = createDispatchGuard({ dbPath: join(dir, "d.db"), budgets: () => [budget({ mode: "monitor", max: 1 })], now: c.now });
  assert.equal((await guard.authorize(req({ action_group: "a" }))).allow, true);
  const over = await guard.authorize(req({ action_group: "b" }));
  assert.equal(over.allow, true);
  assert.equal(over.budgets[0].state, "over");
  guard.close();
});

test("a clock set backwards cannot reopen a window: enforce denies until the clock catches up", async () => {
  const dir = dirOf(); const c = clock();
  const guard = createDispatchGuard({ dbPath: join(dir, "d.db"), budgets: () => [budget({ max: 1 })], now: c.now });
  assert.equal((await guard.authorize(req({ action_group: "a" }))).allow, true);
  c.t += 120_000; // the window has fully elapsed
  assert.equal((await guard.authorize(req({ action_group: "b" }))).allow, true);
  c.t -= 3_600_000; // rolled back an hour
  const rolled = await guard.authorize(req({ action_group: "c" }));
  assert.equal(rolled.allow, false);
  assert.equal(rolled.reason, "clock_rollback");
  c.t += 3_600_000 + 61_000;
  assert.equal((await guard.authorize(req({ action_group: "d" }))).allow, true, "denial ends once the clock passes the mark");
  guard.close();
});

test("a rolled-back clock in monitor mode is counted against the time the store already saw", async () => {
  const dir = dirOf(); const c = clock();
  const guard = createDispatchGuard({ dbPath: join(dir, "d.db"), budgets: () => [budget({ mode: "monitor", max: 1 })], now: c.now });
  await guard.authorize(req({ action_group: "a" }));
  c.t -= 3_600_000;
  const d = await guard.authorize(req({ action_group: "b" }));
  assert.equal(d.allow, true);
  assert.equal(d.budgets[0].state, "unenforceable");
  guard.close();
});

test("an unavailable counter never means unlimited dispatch under enforcement", async () => {
  const dir = dirOf(); const c = clock();
  mkdirSync(join(dir, "blocked.db")); // a directory where the database file should be
  const enforcing = createDispatchGuard({ dbPath: join(dir, "blocked.db"), budgets: () => [budget()], now: c.now });
  const denied = await enforcing.authorize(req());
  assert.equal(denied.allow, false);
  assert.equal(denied.reason, "counter_unavailable");
  const monitoring = createDispatchGuard({ dbPath: join(dir, "blocked.db"), budgets: () => [budget({ mode: "monitor" })], now: c.now });
  const observed = await monitoring.authorize(req());
  assert.equal(observed.allow, true);
  assert.equal(observed.budgets[0].state, "unavailable", "monitoring reports the gap rather than hiding it");
});

test("a shared_gateway limit cannot be enforced by independent installations", async () => {
  const c = clock();
  const shared = budget({ authority_scope: "shared_gateway", max: 2 });
  // Two independent installations, each with its own counter file.
  const a = createDispatchGuard({ dbPath: join(dirOf(), "d.db"), budgets: () => [shared], now: c.now });
  const b = createDispatchGuard({ dbPath: join(dirOf(), "d.db"), budgets: () => [shared], now: c.now });
  for (const g of [a, b]) {
    const d = await g.authorize(req());
    assert.equal(d.allow, false);
    assert.equal(d.reason, "budget_capability_unsupported");
  }
  // With a shared in-path gateway configured the same policy is enforceable.
  const gateway = createDispatchGuard({ dbPath: join(dirOf(), "d.db"), budgets: () => [shared], sharedGatewayConfigured: true, now: c.now });
  assert.equal((await gateway.authorize(req({ action_group: "1" }))).allow, true);
  assert.equal((await gateway.authorize(req({ action_group: "2" }))).allow, true);
  assert.equal((await gateway.authorize(req({ action_group: "3" }))).allow, false);
  // And as monitoring only, an independent hook reports it as unenforceable rather than pretending.
  const mon = createDispatchGuard({ dbPath: join(dirOf(), "d.db"), budgets: () => [budget({ authority_scope: "shared_gateway", mode: "monitor" })], now: c.now });
  const observed = await mon.authorize(req());
  assert.equal(observed.allow, true);
  assert.equal(observed.budgets[0].state, "unenforceable");
});

test("independent installations each keep their own count: no global hard cap is claimed", async () => {
  const c = clock();
  const local = () => createDispatchGuard({ dbPath: join(dirOf(), "d.db"), budgets: () => [budget({ max: 2 })], now: c.now });
  const [a, b] = [local(), local()];
  let allowed = 0;
  for (const g of [a, b]) for (let i = 0; i < 4; i++) if ((await g.authorize(req({ action_group: `x${i}` }))).allow) allowed++;
  assert.equal(allowed, 4, "two installations dispatch 2 each for one agent; the per-installation limit is not a shared one");
});

// ── approvals ────────────────────────────────────────────────────────────────

function approvalSetup(extra = {}) {
  const approver = principal(["approver"]);
  const c = clock();
  const dir = dirOf();
  const inbox = [];
  const guard = createDispatchGuard({
    dbPath: join(dir, "d.db"), keys: registry(approver), requireApproval: ["git.push"], approvals: () => inbox, now: c.now, ...extra,
  });
  const r = req();
  const sign = (over = {}) => signDispatchApproval(approver.privateKey, {
    version: "1.0", approval_id: `approval:${Math.random().toString(36).slice(2, 12)}`, approver: { kid: approver.kid, alg: "Ed25519" },
    actor: r.actor, action_type: "git.push", target: r.intents[0].target, policy_digest: r.policy_digest, request_hash: requestHash(r.intents[0].request),
    issued_at: iso(c.t), expires_at: iso(c.t + 60_000), ...over,
  });
  return { approver, c, guard, inbox, r, sign };
}

test("an action needing approval is denied when none is presented", async () => {
  const { guard, r } = approvalSetup();
  const d = await guard.authorize(r);
  assert.equal(d.allow, false);
  assert.equal(d.reason, "approval_required");
});

test("a bound approval is consumed once: the replay is rejected", async () => {
  const { guard, inbox, r, sign } = approvalSetup();
  const a = sign(); inbox.push(a);
  const first = await guard.authorize(r);
  assert.equal(first.allow, true);
  assert.deepEqual(first.consumed_approvals, [a.approval_id]);
  const replay = await guard.authorize({ ...r, action_group: "another-call" });
  assert.equal(replay.allow, false);
  assert.equal(replay.reason, "approval_replayed");
});

test("a changed action, actor, target, policy, type or expiry after approval is rejected and consumes nothing", async () => {
  const { guard, inbox, r, sign, c } = approvalSetup();
  const a = sign(); inbox.push(a);
  const changed = { ...r, intents: [intent({ params: { ref: "main" } })] };
  for (const [label, attempt] of [
    ["changed request", changed],
    ["wrong actor", { ...r, actor: "agent-2" }],
    ["changed policy", { ...r, policy_digest: "pd-2" }],
  ]) {
    const d = await guard.authorize({ ...attempt, action_group: `try-${label}` });
    assert.equal(d.allow, false, label);
    assert.equal(d.reason, "approval_rejected", label);
  }
  c.t += 61_000;
  assert.equal((await guard.authorize({ ...r, action_group: "late" })).allow, false, "expired");
  c.t -= 61_000; // the time-set-back cannot revive it either
  assert.equal((await guard.authorize({ ...r, action_group: "revived" })).allow, false, "a rolled-back clock does not revive an expired approval");
});

test("an approval is refused for the wrong action type, a self-approval, an unknown approver, a forged signature and a long lifetime", async () => {
  const { guard, inbox, r, sign, approver, c } = approvalSetup();
  const attacker = principal(["approver"]);
  const cases = [
    sign({ action_type: "git.tag" }),
    sign({ approver: { kid: r.actor, alg: "Ed25519" } }),
    signDispatchApproval(attacker.privateKey, { ...sign(), approver: { kid: attacker.kid, alg: "Ed25519" } }),
    { ...sign(), signature: edSign(null, Buffer.from("x"), approver.privateKey).toString("base64") },
    sign({ expires_at: iso(c.t + 3_600_000) }),
    sign({ issued_at: iso(c.t + 3_600_000), expires_at: iso(c.t + 3_660_000) }),
  ];
  for (const a of cases) {
    inbox.length = 0; inbox.push(a);
    assert.equal((await guard.authorize({ ...r, action_group: `g-${a.approval_id}` })).allow, false);
  }
});

test("a denial for another reason spends neither the approval nor a budget slot", async () => {
  const { guard, inbox, r, sign, c } = approvalSetup({ budgets: () => [budget({ max: 1 })] });
  const a = sign(); inbox.push(a);
  const first = await guard.authorize(r);
  assert.equal(first.allow, true);
  // Budget full; the next call has a fresh approval but is over budget: denied, approval stays usable.
  const second = sign(); inbox.length = 0; inbox.push(second);
  const over = await guard.authorize({ ...r, action_group: "over" });
  assert.equal(over.allow, false);
  assert.equal(over.reason, "budget_exceeded");
  c.t += 61_000;
  const again = sign(); inbox.length = 0; inbox.push(second, again);
  const later = await guard.authorize({ ...r, action_group: "later" });
  assert.equal(later.allow, true, "the approval the denied call did not spend is still valid");
  assert.equal(later.consumed_approvals.length, 1);
});

test("concurrent uses of one approval from separate processes dispatch exactly once", async () => {
  const dir = dirOf();
  const approver = principal(["approver"]);
  const r = req();
  const now = Date.now();
  const a = signDispatchApproval(approver.privateKey, {
    version: "1.0", approval_id: "approval:concurrent-0001", approver: { kid: approver.kid, alg: "Ed25519" }, actor: r.actor, action_type: "git.push",
    target: r.intents[0].target, policy_digest: r.policy_digest, request_hash: requestHash(r.intents[0].request), issued_at: iso(now), expires_at: iso(now + 120_000),
  });
  // The child reads its inputs as JSON from argv, so no data is interpolated into its source.
  const script = `
    const cfg = JSON.parse(process.argv[1]);
    const { createDispatchGuard } = await import(cfg.nodeUrl);
    const { StaticPrincipalKeyRegistry } = await import(cfg.indexUrl);
    const g = createDispatchGuard({ dbPath: cfg.dbPath, requireApproval: ["git.push"], approvals: () => [cfg.approval],
      keys: new StaticPrincipalKeyRegistry([{ kid: cfg.kid, publicKeyPem: cfg.publicKeyPem, purposes: ["approver"], status: "active" }]) });
    const d = await g.authorize({ ...cfg.request, action_group: process.argv[2] });
    console.log(d.allow ? "allow" : d.reason); g.close();
  `;
  const cfg = JSON.stringify({
    nodeUrl: pathToFileURL(join(import.meta.dirname, "../dist/node.js")).href,
    indexUrl: pathToFileURL(join(import.meta.dirname, "../dist/index.js")).href,
    dbPath: join(dir, "d.db"), approval: a, request: r, kid: approver.kid, publicKeyPem: approver.publicKeyPem,
  });
  new DispatchStore(join(dir, "d.db")).close();
  const run = (i) => new Promise((resolve, reject) => execFile(process.execPath, ["--input-type=module", "-e", script, cfg, `g${i}`], (e, out, err) => e ? reject(new Error(err || e.message)) : resolve(out.trim())));
  const outcomes = await Promise.all(Array.from({ length: 8 }, (_, i) => run(i)));
  assert.equal(outcomes.filter((o) => o === "allow").length, 1, JSON.stringify(outcomes));
  assert.equal(outcomes.filter((o) => o === "approval_replayed").length, 7);
});

// ── delegation ───────────────────────────────────────────────────────────────

function grant(id, parent, actor, scope, ttl, issued = T0) {
  return { delegation_id: id, parent_id: parent, actor, scope, scope_digest: scopeDigest(scope), issued_at: iso(issued), expires_at: iso(issued + ttl) };
}

test("a child scope must be a subset of its parent and end no later than it", () => {
  const c = clock();
  const store = new DispatchStore(join(dirOf(), "d.db"), c.now);
  const root = grant("deleg:root-000001", null, "agent-1", { action_types: ["git.push", "file.write"], targets: ["repo/*"] }, 3_600_000);
  assert.deepEqual(store.addDelegation(root), { ok: true });
  const ok = grant("deleg:child-00001", root.delegation_id, "agent-1", { action_types: ["file.write"], targets: ["repo/src/*"] }, 1_800_000);
  assert.deepEqual(store.addDelegation(ok), { ok: true });
  const problems = [
    [grant("deleg:wide-type-01", root.delegation_id, "a", { action_types: ["shell.exec"], targets: ["repo/*"] }, 1000), "not_subset"],
    [grant("deleg:wide-targ-01", root.delegation_id, "a", { action_types: ["file.write"], targets: ["other/*"] }, 1000), "not_subset"],
    [grant("deleg:no-targets-1", root.delegation_id, "a", { action_types: ["file.write"] }, 1000), "not_subset"],
    [grant("deleg:outlives-001", root.delegation_id, "a", { action_types: ["file.write"], targets: ["repo/a"] }, 7_200_000), "outlives_parent"],
    [grant("deleg:orphan-0001", "deleg:missing-01", "a", { action_types: ["file.write"] }, 1000), "unknown_parent"],
    [{ ...ok, delegation_id: "deleg:child-00002", scope_digest: "0".repeat(64) }, "digest_mismatch"],
    [ok, "already_exists"],
  ];
  for (const [d, problem] of problems) assert.deepEqual(store.addDelegation(d), { ok: false, problem }, problem);
  store.close();
});

test("the guard enforces delegated scope, expiry, and cascading revocation on every check", async () => {
  const c = clock();
  const db = join(dirOf(), "d.db");
  const store = new DispatchStore(db, c.now);
  const root = grant("deleg:root-000001", null, "agent-1", { action_types: ["git.push", "file.write"], targets: ["feature/*", "src/*"] }, 3_600_000);
  const child = grant("deleg:child-00001", root.delegation_id, "agent-1", { action_types: ["git.push"], targets: ["feature/*"] }, 600_000);
  const grandchild = grant("deleg:grand-00001", child.delegation_id, "agent-1", { action_types: ["git.push"], targets: ["feature/x"] }, 300_000);
  for (const d of [root, child, grandchild]) assert.equal(store.addDelegation(d).ok, true);
  store.close();
  const guard = createDispatchGuard({ dbPath: db, now: c.now });
  const use = (id, over = {}) => guard.authorize(req({ delegation_id: id, action_group: `g-${Math.random()}`, ...over }));
  assert.equal((await use(grandchild.delegation_id)).allow, true);
  assert.equal((await use(grandchild.delegation_id, { intents: [intent({ params: { ref: "feature/y" } })] })).reason, "delegation_out_of_scope");
  assert.equal((await use(grandchild.delegation_id, { actor: "agent-2" })).reason, "delegation_wrong_actor");
  assert.equal((await use("deleg:never-registered")).reason, "delegation_unknown", "unknown ancestry grants nothing");
  const revoker = new DispatchStore(db, c.now);
  revoker.revoke(child.delegation_id); // revoking the middle revokes the leaf, checked on the very next action
  revoker.close();
  assert.equal((await use(grandchild.delegation_id)).reason, "delegation_revoked");
  assert.equal((await use(root.delegation_id)).allow, true, "the root is unaffected");
  c.t += 3_700_000;
  assert.equal((await use(root.delegation_id)).reason, "delegation_expired");
  guard.close();
});

test("revocations imported from a list are add-only and take effect immediately", async () => {
  const c = clock();
  const db = join(dirOf(), "d.db");
  const store = new DispatchStore(db, c.now);
  const root = grant("deleg:root-000001", null, "agent-1", { action_types: ["git.push"] }, 3_600_000);
  store.addDelegation(root);
  assert.equal(store.importRevocations([root.delegation_id, root.delegation_id, ""]), 1);
  assert.equal(store.importRevocations([root.delegation_id]), 0);
  store.close();
  const guard = createDispatchGuard({ dbPath: db, now: c.now });
  assert.equal((await guard.authorize(req({ delegation_id: root.delegation_id }))).reason, "delegation_revoked");
  guard.close();
});

// ── the gateway boundary: upstream invocation count zero ─────────────────────

test("through the gateway a denied dispatch never reaches the upstream and spends nothing", async () => {
  const agent = principal(["agent"]);
  const c = clock();
  const policy = { vocabulary_version: "1.0", policy_id: "d", version: 1, clauses: [{ id: "a", type: "action_allowlist", mode: "enforce", action_types: ["tool.call"] }] };
  let upstream = 0;
  const guard = createDispatchGuard({ dbPath: join(dirOf(), "d.db"), budgets: () => [budget({ operations: ["tool.call"], actor: agent.kid, max: 1 })], now: c.now });
  const gw = createGateway({
    policy, now: () => iso(c.t), authentication: { keys: registry(agent) }, dispatchGuard: guard,
    executor: { id: "test:upstream", mode: "dispatch", execute: async () => { upstream++; return { ref: "ok" }; } },
  });
  const sign = (n) => {
    const it = { action_type: "tool.call", params: { n }, signer: agent.kid };
    const claims = { version: "1.0", request_id: `request:dispatch-${n}-0001`, issued_at: iso(c.t), expires_at: iso(c.t + 60_000), signer: { kid: agent.kid, alg: "Ed25519" }, intent_hash: intentHash(it) };
    return { intent: it, authorization: { ...claims, signature: edSign(null, Buffer.from(canonical(claims)), agent.privateKey).toString("base64") } };
  };
  assert.equal((await gw.handleAction(sign(1))).allowed, true);
  assert.equal(upstream, 1);
  const over = await gw.handleAction(sign(2));
  assert.equal(over.allowed, false);
  assert.match(over.reason, /budget_exceeded/);
  assert.equal(over.receipt.payload.execution.state, "denied");
  assert.equal(upstream, 1, "the over-budget action never reached the upstream");
  guard.close();
});

// ── the gateway's own approval path (R19): nothing rejected reaches the upstream ─

test("gateway approvals: replay, a changed action, expiry and another agent's request are rejected and the upstream is never invoked", async () => {
  const agent = principal(["agent"]);
  const other = principal(["agent"]);
  const approver = principal(["approver"]);
  const AT = "2026-09-30T12:00:00.000Z";
  const policy = { vocabulary_version: "1.0", policy_id: "r19", version: 1, clauses: [{ id: "review", type: "require_approval", mode: "require_approval", action_types: ["tool.call"], approvers: [approver.kid] }] };
  let upstream = 0;
  const gw = createGateway({
    policy, now: () => AT, authentication: { keys: registry(agent, other, approver) },
    executor: { id: "test:r19", mode: "dispatch", execute: async () => { upstream++; return { ref: "ok" }; } },
  });
  const signed = (who, params, n) => {
    const it = { action_type: "tool.call", params, signer: who.kid };
    const claims = { version: "1.0", request_id: `request:r19-${n}-0000001`, issued_at: AT, expires_at: "2026-09-30T12:04:00.000Z", signer: { kid: who.kid, alg: "Ed25519" }, intent_hash: intentHash(it) };
    return { intent: it, authorization: { ...claims, signature: edSign(null, Buffer.from(canonical(claims)), who.privateKey).toString("base64") } };
  };
  const approve = (it, id, expires = "2026-09-30T12:04:00.000Z") => {
    const claims = { version: "1.0", approval_id: id, issued_at: AT, expires_at: expires, approver: { kid: approver.kid, alg: "Ed25519" }, intent_hash: intentHash(it), policy_ref: { id: "r19", version: 1, digest: gw.policyHash }, decision: "approve" };
    return { ...claims, signature: edSign(null, Buffer.from(canonical(claims)), approver.privateKey).toString("base64") };
  };
  const attempt = async (request) => { try { return (await gw.handleAction(request)).allowed; } catch { return false; } };

  const good = signed(agent, { to: "a" }, 1);
  good.approval = approve(good.intent, "approval:r19-good-0001");
  assert.equal(await attempt(good), true);
  assert.equal(upstream, 1);

  const replay = signed(agent, { to: "a" }, 2);
  replay.approval = good.approval;
  assert.equal(await attempt(replay), false, "replay");

  const changed = signed(agent, { to: "b" }, 3);
  changed.approval = approve(signed(agent, { to: "a" }, 9).intent, "approval:r19-changed-01");
  assert.equal(await attempt(changed), false, "changed action");

  const expired = signed(agent, { to: "c" }, 4);
  expired.approval = approve(expired.intent, "approval:r19-expired-01", "2026-09-30T11:59:00.000Z");
  assert.equal(await attempt(expired), false, "expired");

  const stolen = signed(other, { to: "a" }, 5);
  stolen.approval = { ...good.approval, approval_id: "approval:r19-stolen-01" };
  assert.equal(await attempt(stolen), false, "another agent cannot use it");

  assert.equal(upstream, 1, "only the first, bound approval ever reached the upstream");
});
