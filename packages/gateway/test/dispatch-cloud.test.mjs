import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import {
  actionScopeEntry, actionScopeEntries, SCOPE_ENTRY_KINDS, dispatchApprovalBinding, budgetDigest, canonical, createCloudDispatchSource, createGateway, defaultBudgetTemplate, delegationScopeDigest, deriveKid, dispatchIntentOf,
  intentHash, privilegeScopeEntry, requestHash, scopeEntryDigest, signDispatchApproval, StaticPrincipalKeyRegistry,
} from "../dist/index.js";
import { createDispatchGuard, DispatchStore } from "../dist/node.js";

const T0 = Date.parse("2026-09-30T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const dirOf = () => mkdtempSync(join(tmpdir(), "sb-dispatch-cloud-"));
function clock(start = T0) { const c = { t: start, now: () => c.t }; return c; }
const HEX = /^[0-9a-f]{64}$/;

// ── golden vectors: the digests a workspace computes, as literals ────────────────────────────

test("scope digest formulas equal the workspace's, byte for byte", () => {
  const entryA = scopeEntryDigest("action", "entry-1");
  const entryB = scopeEntryDigest("action", "entry-2");
  assert.equal(entryA, "ce567c682651aaa4e6d11f77897411a3fc5a64be02656d94a184a8bc96a12065");
  assert.equal(entryB, "805c2f86a3a7f70d9d0f8966b4b24a1dd78c17a54d8729f7ffb620863b99d3d2");
  assert.equal(privilegeScopeEntry("repo-1", "admin"), "aea6610851c1bdd71d7ed62b157fe30f91c541d2b4b9677186257b37d1753e59");
  assert.equal(scopeEntryDigest("action", "git.push\u0000*"), "44917e984d2eb56ec5d91f85ab79890f364b89471017933ba1642665bb16c3ed");
  assert.equal(actionScopeEntries("git.push", "x").anyTarget, "44917e984d2eb56ec5d91f85ab79890f364b89471017933ba1642665bb16c3ed");
  assert.equal(delegationScopeDigest([]), "2f07decfc136906429c6397ba4d75a42004c9fa9921d32f2362260ded0894412");
  assert.equal(delegationScopeDigest([entryA]), "eda4c538e770d136507787c3306ac079ff5044c66ff30390c5d208834a0b127d");
  // Sorted and de-duplicated before it is bound.
  assert.equal(delegationScopeDigest([entryB, entryA, entryA]), "a83342cb60d6e988c734b8e0ff8e0c4b79a3920b6e3195b419c6142b082a44fe");
  assert.equal(delegationScopeDigest([entryA, entryB]), delegationScopeDigest([entryB, entryA, entryB]));
});

// ── a fake workspace ─────────────────────────────────────────────────────────────────────────

const CONSUME_KEYS = ["action_type", "approval_id", "client_time", "policy_digest", "request_hash", "target_id"];

/** Stands in for the workspace's two machine routes, with its refusal semantics (strict keys, one conditional consume). */
function fakeWorkspace(c) {
  const ws = {
    approvals: new Map(), // id -> { action_type, policy_digest, request_hash, target_id, state, expires }
    delegations: new Map(), // session -> resolved delegation (server field names)
    consumes: [], delegationCalls: 0, delegationQueries: [], activeQueries: [], covers: "server", noActive: false, down: false, status: null, credentials: [],
  };
  ws.fetch = async (url, init) => {
    ws.credentials.push(init.headers.authorization);
    if (ws.down) throw new TypeError("fetch failed");
    if (ws.status) return new Response("{}", { status: ws.status });
    const u = new URL(url);
    if (u.pathname === "/v1/monitoring/approvals/consume" && init.method === "POST") {
      const body = JSON.parse(init.body);
      ws.consumes.push(body);
      if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(CONSUME_KEYS)) return Response.json({ error: "bad" }, { status: 400 });
      const a = ws.approvals.get(body.approval_id);
      const refuse = (reason) => Response.json({ ok: false, reason }, { status: 409 });
      if (!a) return refuse("not_found");
      if (a.state === "consumed") return refuse("consumed");
      if (a.state === "revoked") return refuse("revoked");
      if (a.expires <= c.t) return refuse("expired");
      if (Math.abs(Date.parse(body.client_time) - c.t) > 30_000) return refuse("clock_uncertain");
      for (const [field, reason] of [["action_type", "action_mismatch"], ["policy_digest", "policy_mismatch"], ["request_hash", "request_mismatch"], ["target_id", "target_mismatch"]]) {
        if (a[field] !== body[field]) return refuse(reason);
      }
      a.state = "consumed";
      return Response.json({ ok: true, approval_id: a.id, consumed_at: c.t }, { status: 200 });
    }
    if (u.pathname === "/v1/monitoring/delegations" && init.method === "GET") {
      ws.delegationCalls++;
      const d = ws.delegations.get(u.searchParams.get("session_id")) ?? resolved("not_found", []);
      ws.delegationQueries.push(Object.fromEntries(u.searchParams));
      const at = u.searchParams.get("action_type"), tid = u.searchParams.get("target_id");
      // The server's own convention (actionScopeEntry over the target id it was sent).
      const covers = at !== null && tid !== null ? { covers: ws.covers === "server" ? (d.grants && [actionScopeEntry(at, tid), actionScopeEntry(at, null)].some((e) => d.effective_entries.includes(e))) : ws.covers } : {};
      return Response.json({ version: 1, delegation: d, ...(ws.omitCovers ? {} : covers) }, { status: 200 });
    }
    if (u.pathname === "/v1/monitoring/approvals/active" && init.method === "GET") {
      const q = Object.fromEntries(u.searchParams);
      ws.activeQueries.push(q);
      const found = ws.noActive ? undefined : [...ws.approvals.values()].find((a) => a.state === "active" && a.expires > c.t && a.request_hash === q.request_hash && a.action_type === q.action_type && a.target_id === q.target_id);
      return Response.json({ version: 1, active: !!found, ...(found ? { approval_id: found.id, expires_at: found.expires } : {}) }, { status: 200 });
    }
    return new Response("nope", { status: 404 });
  };
  return ws;
}

function resolved(state, entries, over = {}) {
  return {
    session_id: "s", state, reason: "r", grants: state === "active" && entries.length > 0, effective_entries: entries, effective_scope_digest: delegationScopeDigest(entries),
    effective_expires_at: null, exceeds_parent: false, lifetime_clamped: false, depth: 1, agent_id: "agent", ...over,
  };
}

const POLICY = "b".repeat(64);
const intent = (over = {}) => dispatchIntentOf({ action_type: "git.push", params: { ref: "feature/x", action_group: "g" }, ...over });
const req = (over = {}) => ({ actor: "agent-1", action_group: "group-1", policy_digest: POLICY, intents: [intent()], ...over });
const targetId = (t) => `sbt_${Buffer.from(t).toString("hex").slice(0, 16)}`;

function setup(extra = {}) {
  const c = clock();
  const ws = fakeWorkspace(c);
  const inbox = [];
  const cloud = createCloudDispatchSource({ url: "https://cloud.test", credential: "sbm_secret", targetId, fetch: ws.fetch });
  const guard = createDispatchGuard({ dbPath: join(dirOf(), "d.db"), requireApproval: ["git.push"], approvals: () => inbox, now: c.now, cloud, ...extra });
  const r = req();
  const grant = (id = "appr-0001", over = {}) => {
    const { discover, ...rest } = over;
    if (!discover) inbox.push({ cloud_approval_id: id });
    ws.approvals.set(id, { id, action_type: "git.push", policy_digest: r.policy_digest, request_hash: requestHash(r.intents[0].request), target_id: targetId(r.intents[0].target), state: "active", expires: c.t + 60_000, ...rest });
  };
  return { c, ws, inbox, guard, r, grant };
}

// ── approvals consumed in the workspace ──────────────────────────────────────────────────────

test("a workspace approval is consumed at dispatch with the exact request body, once", async () => {
  const { ws, guard, r, grant } = setup();
  grant();
  const d = await guard.authorize(r);
  assert.equal(d.allow, true);
  assert.deepEqual(d.consumed_approvals, ["appr-0001"]);
  assert.equal(ws.consumes.length, 1);
  const body = ws.consumes[0];
  assert.deepEqual(Object.keys(body).sort(), CONSUME_KEYS);
  assert.equal(body.approval_id, "appr-0001");
  assert.equal(body.action_type, "git.push");
  assert.equal(body.policy_digest, POLICY);
  assert.equal(body.request_hash, requestHash(r.intents[0].request));
  assert.match(body.request_hash, HEX);
  assert.equal(body.target_id, targetId("feature/x"));
  assert.ok(!JSON.stringify(body).includes("feature/x"), "no raw target leaves the machine");
  assert.equal(ws.credentials[0], "Bearer sbm_secret");
  const replay = await guard.authorize({ ...r, action_group: "again" });
  assert.equal(replay.allow, false);
  assert.equal(replay.reason, "approval_replayed");
  guard.close();
});

test("every closed refusal the workspace gives means not approved", async () => {
  const cases = [
    ["missing", null, undefined, "approval_rejected", /not_found/],
    ["revoked", { state: "revoked" }, undefined, "approval_rejected", /revoked/],
    ["expired", { expires: T0 - 1 }, undefined, "approval_rejected", /expired/],
    ["other request", { request_hash: "c".repeat(64) }, undefined, "approval_rejected", /request_mismatch/],
    ["other target", { target_id: "sbt_other" }, undefined, "approval_rejected", /target_mismatch/],
    ["other policy", { policy_digest: "d".repeat(64) }, undefined, "approval_rejected", /policy_mismatch/],
    ["other action", { action_type: "git.tag" }, undefined, "approval_rejected", /action_mismatch/],
  ];
  for (const [label, over, , reason, detail] of cases) {
    const { guard, r, grant, inbox } = setup();
    if (over) grant("appr-0001", over); else inbox.push({ cloud_approval_id: "appr-missing" });
    const d = await guard.authorize(r);
    assert.equal(d.allow, false, label);
    assert.equal(d.reason, reason, label);
    assert.match(d.detail, detail, label);
    guard.close();
  }
});

test("an unreachable or failing workspace with no valid local approval denies in enforce; a 4xx or 5xx never approves", async () => {
  for (const [label, arrange, reason] of [
    ["down", (ws) => { ws.down = true; }, "approval_unavailable"],
    ["503", (ws) => { ws.status = 503; }, "approval_unavailable"],
    ["401", (ws) => { ws.status = 401; }, "approval_rejected"],
    ["200 without ok", (ws) => { ws.fetch = async () => Response.json({ hello: 1 }, { status: 200 }); }, "approval_rejected"],
  ]) {
    const c = clock();
    const ws = fakeWorkspace(c);
    arrange(ws);
    const inbox = [{ cloud_approval_id: "appr-0001" }];
    const cloud = createCloudDispatchSource({ url: "https://cloud.test", credential: "x", targetId, fetch: (...a) => ws.fetch(...a) });
    const guard = createDispatchGuard({ dbPath: join(dirOf(), "d.db"), requireApproval: ["git.push"], approvals: () => inbox, now: c.now, cloud });
    const d = await guard.authorize(req());
    assert.equal(d.allow, false, label);
    assert.equal(d.reason, reason, label);
    guard.close();
  }
});

test("a valid local signed approval still works when the workspace is down, and is tried before the workspace", async () => {
  const pair = generateKeyPairSync("ed25519");
  const raw = pair.publicKey.export({ format: "jwk" });
  const kid = deriveKid({ crv: raw.crv, kty: raw.kty, x: raw.x });
  const keys = new StaticPrincipalKeyRegistry([{ kid, publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), purposes: ["approver"], status: "active" }]);
  const { c, ws, inbox, guard: unused, r, grant } = setup();
  unused.close();
  ws.down = true;
  const cloud = createCloudDispatchSource({ url: "https://cloud.test", credential: "x", targetId, fetch: ws.fetch });
  const guard = createDispatchGuard({ dbPath: join(dirOf(), "d2.db"), keys, requireApproval: ["git.push"], approvals: () => inbox, now: c.now, cloud });
  grant("appr-0002");
  const local = signDispatchApproval(pair.privateKey, {
    version: "1.0", approval_id: "approval:local-0001", approver: { kid, alg: "Ed25519" }, actor: r.actor, action_type: "git.push", target: "feature/x",
    policy_digest: r.policy_digest, request_hash: requestHash(r.intents[0].request), issued_at: iso(c.t), expires_at: iso(c.t + 60_000),
  });
  inbox.push(local);
  const d = await guard.authorize(r);
  assert.equal(d.allow, true);
  assert.deepEqual(d.consumed_approvals, ["approval:local-0001"]);
  assert.equal(ws.consumes.length, 0, "the workspace was not asked");
  guard.close();
});

test("a refusal by the budget, or a replayed local id, never spends the workspace approval", async () => {
  const c = clock();
  const ws = fakeWorkspace(c);
  const cloud = createCloudDispatchSource({ url: "https://cloud.test", credential: "x", targetId, fetch: ws.fetch });
  const b = { ...defaultBudgetTemplate("agent-1", ["git.push"], new Date(T0)), max: 1, window_seconds: 60, mode: "enforce" };
  b.acknowledgement = { digest: budgetDigest(b), acknowledged_at: iso(T0) };
  const inbox = [];
  const guard = createDispatchGuard({ dbPath: join(dirOf(), "d.db"), requireApproval: ["git.push"], approvals: () => inbox, budgets: () => [b], now: c.now, cloud });
  const r = req();
  const put = (id) => { ws.approvals.set(id, { id, action_type: "git.push", policy_digest: r.policy_digest, request_hash: requestHash(r.intents[0].request), target_id: targetId("feature/x"), state: "active", expires: c.t + 60_000 }); inbox.length = 0; inbox.push({ cloud_approval_id: id }); };
  put("appr-first-1");
  assert.equal((await guard.authorize(r)).allow, true);
  put("appr-second-2");
  const over = await guard.authorize({ ...r, action_group: "second" });
  assert.equal(over.allow, false);
  assert.equal(over.reason, "budget_exceeded");
  assert.equal(ws.approvals.get("appr-second-2").state, "active", "the person's approval survives a refusal for another reason");
  assert.equal(ws.consumes.length, 1);
  guard.close();
});

test("without a workspace the local-file path behaves exactly as before, and a workspace reference alone approves nothing", async () => {
  const c = clock();
  const inbox = [{ cloud_approval_id: "appr-0001" }];
  const guard = createDispatchGuard({ dbPath: join(dirOf(), "d.db"), requireApproval: ["git.push"], approvals: () => inbox, now: c.now });
  const d = await guard.authorize(req());
  assert.equal(d.allow, false);
  assert.equal(d.reason, "approval_required");
  guard.close();
});

test("through the gateway a workspace-refused approval never reaches the upstream", async () => {
  const pair = generateKeyPairSync("ed25519");
  const raw = pair.publicKey.export({ format: "jwk" });
  const kid = deriveKid({ crv: raw.crv, kty: raw.kty, x: raw.x });
  const c = clock();
  const ws = fakeWorkspace(c);
  const cloud = createCloudDispatchSource({ url: "https://cloud.test", credential: "x", targetId, fetch: ws.fetch });
  const inbox = [{ cloud_approval_id: "appr-0001" }];
  const guard = createDispatchGuard({ dbPath: join(dirOf(), "d.db"), requireApproval: ["tool.call"], approvals: () => inbox, now: c.now, cloud });
  const policy = { vocabulary_version: "1.0", policy_id: "d", version: 1, clauses: [{ id: "a", type: "action_allowlist", mode: "enforce", action_types: ["tool.call"] }] };
  let upstream = 0;
  const gw = createGateway({
    policy, now: () => iso(c.t), authentication: { keys: new StaticPrincipalKeyRegistry([{ kid, publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), purposes: ["agent"], status: "active" }]) }, dispatchGuard: guard,
    executor: { id: "test:upstream", mode: "dispatch", execute: async () => { upstream++; return { ref: "ok" }; } },
  });
  const signed = (n) => {
    const it = { action_type: "tool.call", params: { n }, signer: kid };
    const claims = { version: "1.0", request_id: `request:cloud-${n}-0001`, issued_at: iso(c.t), expires_at: iso(c.t + 60_000), signer: { kid, alg: "Ed25519" }, intent_hash: intentHash(it) };
    return { intent: it, authorization: { ...claims, signature: edSign(null, Buffer.from(canonical(claims)), pair.privateKey).toString("base64") } };
  };
  // Not in the workspace: refused, and nothing ran.
  const refused = await gw.handleAction(signed(1));
  assert.equal(refused.allowed, false);
  assert.equal(upstream, 0);
  // Unreachable: refused, and nothing ran.
  ws.down = true;
  assert.equal((await gw.handleAction(signed(2))).allowed, false);
  assert.equal(upstream, 0, "the upstream is never invoked for an approval the workspace did not consume");
  guard.close();
});

// ── delegation resolved by the workspace ─────────────────────────────────────────────────────

function delegated(entriesFor = () => [actionScopeEntries("git.push", targetId("feature/x")).exact]) {
  const s = setup({ requireApproval: [], cloud: undefined });
  s.guard.close();
  const c = s.c, ws = s.ws;
  const cloud = createCloudDispatchSource({ url: "https://cloud.test", credential: "x", targetId, fetch: (...a) => ws.fetch(...a) });
  const guard = createDispatchGuard({ dbPath: join(dirOf(), "d.db"), now: c.now, cloud });
  ws.delegations.set("sess-1", resolved("active", entriesFor()));
  return { c, ws, guard, r: req({ delegation_id: "sess-1" }) };
}

test("a session the workspace resolves as active and covering is allowed; anything else is refused", async () => {
  const { ws, guard, r } = delegated();
  assert.equal((await guard.authorize(r)).allow, true);
  const other = { ...r, action_group: "g2", intents: [intent({ params: { ref: "main" } })] };
  const out = await guard.authorize(other);
  assert.equal(out.allow, false);
  assert.equal(out.reason, "delegation_out_of_scope");
  ws.delegations.set("sess-any", resolved("active", [actionScopeEntries("git.push", "x").anyTarget]));
  assert.equal((await guard.authorize({ ...other, delegation_id: "sess-any", action_group: "g3" })).allow, true, "an any-target entry covers every target of that action type");
  guard.close();
});

test("revoked, ended, expired, unknown ancestry, invalid scope and unknown sessions grant nothing", async () => {
  for (const [state, reason] of [["revoked", "delegation_revoked"], ["ended", "delegation_expired"], ["expired", "delegation_expired"], ["unknown_ancestry", "delegation_unknown"], ["invalid_scope", "delegation_unknown"], ["not_found", "delegation_unknown"]]) {
    const { ws, guard, r } = delegated();
    ws.delegations.set("sess-1", resolved(state, [actionScopeEntries("git.push", targetId("feature/x")).exact]));
    const d = await guard.authorize(r);
    assert.equal(d.allow, false, state);
    assert.equal(d.reason, reason, state);
    guard.close();
  }
});

test("an unreachable workspace, a malformed answer, a digest that does not bind the entries, or an expired scope deny", async () => {
  const { ws, guard, r, c } = delegated();
  ws.down = true;
  assert.equal((await guard.authorize(r)).reason, "delegation_unknown");
  ws.down = false;
  ws.delegations.set("sess-1", { ...resolved("active", [actionScopeEntries("git.push", targetId("feature/x")).exact]), effective_scope_digest: "0".repeat(64) });
  const forged = await guard.authorize({ ...r, action_group: "g2" });
  assert.equal(forged.allow, false);
  assert.match(forged.detail, /does not bind/);
  ws.delegations.set("sess-1", resolved("active", ["not-hex"]));
  assert.equal((await guard.authorize({ ...r, action_group: "g3" })).allow, false);
  ws.delegations.set("sess-1", resolved("active", [actionScopeEntries("git.push", targetId("feature/x")).exact], { effective_expires_at: c.t - 1 }));
  assert.equal((await guard.authorize({ ...r, action_group: "g4" })).reason, "delegation_expired");
  guard.close();
});

test("a resolved grant is cached for a short while, and a revocation is honoured once the cache expires", async () => {
  const { ws, guard, r, c } = delegated();
  assert.equal((await guard.authorize(r)).allow, true);
  assert.equal((await guard.authorize({ ...r, action_group: "g2" })).allow, true);
  assert.equal(ws.delegationCalls, 1, "the second call reused the cached answer");
  ws.delegations.set("sess-1", resolved("revoked", []));
  c.t += 16_000;
  const after = await guard.authorize({ ...r, action_group: "g3" });
  assert.equal(after.allow, false);
  assert.equal(after.reason, "delegation_revoked");
  assert.equal(ws.delegationCalls, 2);
  // A refusal is never cached: the next check asks again.
  await guard.authorize({ ...r, action_group: "g4" });
  assert.equal(ws.delegationCalls, 3);
  // With the workspace down and the cache stale, a previously fine session is refused.
  ws.delegations.set("sess-1", resolved("active", [actionScopeEntries("git.push", targetId("feature/x")).exact]));
  assert.equal((await guard.authorize({ ...r, action_group: "g5" })).allow, true);
  c.t += 16_000; ws.down = true;
  assert.equal((await guard.authorize({ ...r, action_group: "g6" })).allow, false);
  guard.close();
});

test("a delegation the local store knows is judged locally, unchanged, and never asks the workspace", async () => {
  const c = clock();
  const ws = fakeWorkspace(c);
  const cloud = createCloudDispatchSource({ url: "https://cloud.test", credential: "x", targetId, fetch: ws.fetch });
  const path = join(dirOf(), "d.db");
  const store = new DispatchStore(path, c.now);
  const scope = { action_types: ["git.push"], targets: ["feature/*"] };
  const { scopeDigest } = await import("../dist/index.js");
  assert.deepEqual(store.addDelegation({ delegation_id: "local-deleg-1", parent_id: null, actor: "agent-1", scope, scope_digest: scopeDigest(scope), issued_at: iso(T0), expires_at: iso(T0 + 3_600_000) }), { ok: true });
  store.close();
  const guard = createDispatchGuard({ dbPath: path, now: c.now, cloud });
  assert.equal((await guard.authorize(req({ delegation_id: "local-deleg-1" }))).allow, true);
  assert.equal(ws.delegationCalls, 0);
  guard.close();
});

// ── closed scope-entry vocabulary and the ordinary-action entries (the workspace's vectors) ──────

test("scope entries: a closed kind vocabulary, exact and any-target action entries, invalid input refused", () => {
  assert.deepEqual([...SCOPE_ENTRY_KINDS], ["action", "privilege"]);
  assert.equal(actionScopeEntry("git.push", "repo-1"), "40ea10884218f819489ca2c4e46327f3849c5269b18825588eb71201e929d893");
  assert.equal(actionScopeEntry("git.push", null), "44917e984d2eb56ec5d91f85ab79890f364b89471017933ba1642665bb16c3ed");
  assert.equal(actionScopeEntry("git.push", "repo-1"), scopeEntryDigest("action", "git.push\u0000repo-1"));
  assert.throws(() => scopeEntryDigest("secret", "x"));
  assert.throws(() => actionScopeEntry("Git Push", "x"));
  assert.throws(() => actionScopeEntry("git.push", "*"), /target/);
  assert.throws(() => actionScopeEntry("git.push", "a\u0000b"));
  assert.throws(() => actionScopeEntry("git.push", ""));
  assert.throws(() => actionScopeEntry("git.push", "x".repeat(201)));
  assert.deepEqual(actionScopeEntries("git.push", "repo-1"), { exact: actionScopeEntry("git.push", "repo-1"), anyTarget: actionScopeEntry("git.push", null) });
});

test("the approval hash an adapter repeats on its typed operation equals the hash the guard consumes with; golden vectors match the workspace's", () => {
  assert.equal(requestHash({ params: { ref: "main", force: true }, action_type: "git.push" }), "a519d84d7d539f2c2957e5abdb2e4b3e27a3dea671ecf38b7846d50e46131d19");
  assert.equal(requestHash({ server: "gh", method: "tools/call", params: { name: "t", arguments: { a: 1 } } }), "0fb7eee795d973ea21d2288f13da29c03fa7ab8541b70b2beb3a853c197a6064");
  const item = { action_type: "git.push", params: { ref: "main", force: true, action_group: "g", action_group_seq: 2 } };
  const binding = dispatchApprovalBinding(item);
  assert.equal(binding.request_hash, "a519d84d7d539f2c2957e5abdb2e4b3e27a3dea671ecf38b7846d50e46131d19", "the group linkage is not part of the hash");
  assert.equal(binding.target, "main");
  assert.equal(binding.request_hash, requestHash(dispatchIntentOf(item).request));
});

// ── delegation: the workspace's own `covers` answer ──────────────────────────────────────────

test("a delegation check asks with the action and the OPAQUE target id, and the workspace's covers answer decides that action", async () => {
  const { ws, guard, r } = delegated();
  ws.covers = "server";
  assert.equal((await guard.authorize(r)).allow, true);
  assert.deepEqual(ws.delegationQueries[0], { session_id: "sess-1", action_type: "git.push", target_id: targetId("feature/x") });
  assert.ok(!JSON.stringify(ws.delegationQueries).includes("feature/x"), "no raw target leaves the machine");
  // covers false from the workspace is out of scope even though the listed entries would cover it (the workspace's answer governs)
  ws.covers = false;
  ws.delegations.set("sess-2", resolved("active", [actionScopeEntries("git.push", targetId("feature/x")).exact]));
  const no = await guard.authorize({ ...r, delegation_id: "sess-2", action_group: "g9" });
  assert.equal(no.allow, false);
  assert.equal(no.reason, "delegation_out_of_scope");
  // covers true does not revive a revoked delegation
  ws.covers = true;
  ws.delegations.set("sess-3", resolved("revoked", []));
  assert.equal((await guard.authorize({ ...r, delegation_id: "sess-3", action_group: "g10" })).reason, "delegation_revoked");
  guard.close();
});

test("a workspace that gives no covers is judged from the listed entries over the target id; a malformed covers is a bad answer", async () => {
  const { ws, guard, r } = delegated();
  ws.omitCovers = true;
  assert.equal((await guard.authorize(r)).allow, true);
  const other = await guard.authorize({ ...r, action_group: "g2", intents: [intent({ params: { ref: "main" } })] });
  assert.equal(other.reason, "delegation_out_of_scope");
  const bare = createCloudDispatchSource({ url: "https://cloud.test", credential: "x", targetId, fetch: async () => Response.json({ version: 1, delegation: resolved("active", [actionScopeEntry("git.push", null)]) }) });
  assert.equal((await bare.delegation("s", { action_type: "git.push", target_id: "t" })).covers, undefined);
  const bad = createCloudDispatchSource({ url: "https://cloud.test", credential: "x", targetId, fetch: async () => Response.json({ version: 1, covers: "yes", delegation: resolved("active", [actionScopeEntry("git.push", null)]) }) });
  assert.equal((await bad.delegation("s")).reason, "bad_response");
  guard.close();
});

// ── active approval discovery ────────────────────────────────────────────────────────────────

test("with no reference in the inbox the guard finds the active approval for exactly this request and consumes it", async () => {
  const { ws, guard, r, grant } = setup();
  grant("appr-auto-1", { discover: true });
  const d = await guard.authorize(r);
  assert.equal(d.allow, true, d.detail);
  assert.deepEqual(d.consumed_approvals, ["appr-auto-1"]);
  assert.deepEqual(ws.activeQueries[0], { request_hash: requestHash(r.intents[0].request), action_type: "git.push", target_id: targetId("feature/x") });
  assert.ok(!JSON.stringify(ws.activeQueries).includes("feature/x"));
  assert.equal(ws.consumes.length, 1);
  assert.equal((await guard.authorize({ ...r, action_group: "again" })).allow, false, "single use: found once, consumed once");
  guard.close();
});

test("discovery never approves by itself: none found, another request, an unreachable workspace and a manual reference", async () => {
  {
    const { ws, guard, r } = setup();
    const d = await guard.authorize(r);
    assert.equal(d.reason, "approval_required");
    assert.match(d.detail, /request_hash [0-9a-f]{64}/);
    assert.equal(ws.consumes.length, 0);
    guard.close();
  }
  {
    const { ws, guard, r, grant } = setup();
    grant("appr-other", { discover: true, request_hash: "c".repeat(64) });
    assert.equal((await guard.authorize(r)).reason, "approval_required");
    assert.equal(ws.consumes.length, 0);
    guard.close();
  }
  {
    const { ws, guard, r, grant } = setup();
    grant("appr-down", { discover: true });
    ws.status = 503;
    const d = await guard.authorize(r);
    assert.equal(d.allow, false);
    assert.match(d.detail, /could not be asked for an active approval/);
    guard.close();
  }
  {
    // the hand-copied reference still works and is used before any lookup
    const { ws, guard, r, grant } = setup();
    grant("appr-manual");
    assert.equal((await guard.authorize(r)).allow, true);
    assert.equal(ws.activeQueries.length, 0);
    guard.close();
  }
});
