// Answers on the agent's local channel: any program running as this computer's user can read the channel's token, the coding
// agent among them, so an answer that arrives there cannot show a person gave it. Only the next try of that one action is
// allowed on this computer from it, and the allowance is marked `local_unverified`. A longer choice ("always", a length,
// similar commands) makes no allowance here: it is sent to the workspace as a request a person approves, and without a
// workspace it is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MANAGED_DOC_FILE, readAllowances, readBlocked, readRequests } from "@scopebond/hook";
import { callAgent } from "../dist/index.js";
import { computer, blockActions, serviceFor } from "./tray-helpers.mjs";

const REASON = "Integration tests need the build folder gone";
const REPO = "/work/app";
const answer = (dir, body) => callAgent(dir, "POST", "/blocked/answer", body, 10_000);
const later = (ms) => new Promise((r) => setTimeout(r, ms));

/** A workspace that takes allowances and requests, and keeps what it was sent. */
async function workspace() {
  const posted = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (req.url === "/v1/allowances" || req.url === "/v1/requests") posted.push({ path: req.url, body: JSON.parse(raw) });
      res.writeHead(req.url === "/v1/policy" ? 404 : 200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { posted, server, url: `http://127.0.0.1:${server.address().port}` };
}

function connect(dir, url) {
  writeFileSync(join(dir, "cloud.json"), JSON.stringify({
    url, credential: "sbm_us_test", credential_id: "cred-1", organization_id: "org-1", environment_id: "env-1",
    gateway_id: "gw-1", attester_kid: "key:x", scopes: ["receipt:ingest"], expires_at: new Date(Date.now() + 80 * 86_400_000).toISOString(),
  }));
}

/** A connected computer with one block a person may act on, and its agent; the rules document as the workspace sent it. */
async function connectedBlock(rules, uses = [{ tool_name: "Bash", tool_input: { command: "rm -rf ../build" } }], options = {}) {
  const ws = await workspace();
  const dir = computer(rules);
  await blockActions(dir, uses, options);
  connect(dir, ws.url);
  const doc = readFileSync(join(dir, MANAGED_DOC_FILE), "utf8");
  const service = await serviceFor(dir);
  writeFileSync(join(dir, MANAGED_DOC_FILE), doc);
  return { ...ws, dir, service, id: readBlocked(dir).at(-1).id, stop: async () => { await service.stop(); ws.server.close(); } };
}

test("always from the local channel: no allowance for longer on this computer; a request goes to the workspace, and the action is allowed once now", async () => {
  const c = await connectedBlock();
  try {
    // The tray is told what it may offer from here: no lengths, and "always" only as a request an admin approves.
    const { tray } = await callAgent(c.dir, "GET", "/tray", undefined, 10_000);
    const offers = tray.recent_blocks.find((b) => b.action_id === c.id).offers;
    assert.deepEqual([offers.once, offers.fifteen, offers.hour, offers.tomorrow, offers.always, offers.always_needs_admin, offers.ask], [true, false, false, false, true, true, true]);
    const done = await answer(c.dir, { action_id: c.id, choice: "always", reason: REASON });
    assert.equal(done.outcome, "asked");
    assert.equal(done.choice, "always");
    assert.equal(done.requested, "always");
    assert.equal(done.allowed_once, true);
    assert.equal(done.approval, "local_unverified");
    assert.equal(done.text, "Allowed once now: rm -rf ../build (in /repo) · asked your workspace to allow for 14 days; an admin decides");
    const made = readAllowances(c.dir);
    assert.equal(made.filter((a) => !a.once).length, 0, "no allowance beyond the next try");
    assert.equal(made.length, 1);
    assert.equal(made[0].approval, "local_unverified");
    const [request] = readRequests(c.dir);
    assert.equal(request.reason, REASON);
    assert.deepEqual(request.asked_for, { lasts: "always" });
    // Sent to the workspace, signed by this computer's key: the request, and the one-time allowance with its mark.
    await later(1_200);
    await c.service.cycleNow();
    const sentRequest = c.posted.find((p) => p.path === "/v1/requests");
    assert.ok(sentRequest, "the request was sent");
    assert.deepEqual(sentRequest.body.record.asked_for, { lasts: "always" });
    assert.ok(sentRequest.body.signature && sentRequest.body.kid);
    const sentAllowance = c.posted.find((p) => p.path === "/v1/allowances");
    assert.equal(sentAllowance.body.record.once, true);
    assert.equal(sentAllowance.body.record.approval, "local_unverified");
    assert.equal(c.posted.filter((p) => p.path === "/v1/allowances").length, 1, "only the one-time allowance");
  } finally { await c.stop(); }
});

test("a length from the local channel is a request too, and once_now: false asks without allowing anything", async () => {
  const c = await connectedBlock();
  try {
    assert.equal((await answer(c.dir, { action_id: c.id, choice: "fifteen", reason: REASON, once_now: "yes" })).outcome, "invalid");
    const done = await answer(c.dir, { action_id: c.id, choice: "fifteen", reason: REASON, once_now: false });
    assert.equal(done.outcome, "asked");
    assert.equal(done.allowed_once, false);
    assert.equal("approval" in done, false);
    assert.equal(done.text, "Request sent to allow for 15 minutes: rm -rf ../build (in /repo) · an admin decides in your workspace");
    assert.deepEqual(readAllowances(c.dir), [], "nothing allowed here");
    assert.deepEqual(readRequests(c.dir).map((r) => r.asked_for), [{ lasts: "15m" }]);
    assert.equal(readBlocked(c.dir).at(-1).acted, "asked");
  } finally { await c.stop(); }
});

test("similar commands from the local channel: no pattern allowance; a request for them instead", async () => {
  const handler = { repositoryTop: (p) => (p === REPO || p.startsWith(`${REPO}/`) ? REPO : null), real: () => null, cwd: "/repo" };
  const terms = { reason_min: 0, minutes: 0, daily_limit: 5, harness_prompt: false, always: "at_once", always_days: 30, patterns: "person", requests: true };
  const c = await connectedBlock({ "destructive-shell": { mode: "override", override: terms } }, [{ tool_name: "Bash", tool_input: { command: `rm -rf ${REPO}/old-build` } }], { handler });
  try {
    const { tray } = await callAgent(c.dir, "GET", "/tray", undefined, 10_000);
    assert.deepEqual(tray.recent_blocks.find((b) => b.action_id === c.id).offers.similar, {
      recipe_id: "delete-in-folder", words: `Deleting folders inside ${REPO} with rm`, covers: [`rm -r ${REPO}/old-build`], not_covers: ["rm -rf /work"], needs_admin: true,
    }, "offered in words, as a request an admin approves");
    const done = await answer(c.dir, { action_id: c.id, choice: "always", reason: "", scope: "similar", once_now: false });
    assert.equal(done.outcome, "asked");
    assert.equal(done.scope, "similar");
    assert.equal(done.text, `Request sent to allow similar commands for 30 days: deleting folders inside ${REPO} with rm · an admin decides in your workspace`);
    assert.equal(readAllowances(c.dir).length, 0, "no pattern allowance");
    assert.deepEqual(readRequests(c.dir).map((r) => r.asked_for), [{ lasts: "always", scope: "similar" }]);
  } finally { await c.stop(); }
});

test("once from the local channel works as before, and its allowance is marked local_unverified", async () => {
  const dir = computer();
  await blockActions(dir, [{ tool_name: "Bash", tool_input: { command: "rm -rf ../build" } }]);
  const id = readBlocked(dir).at(-1).id;
  const service = await serviceFor(dir);
  try {
    const done = await answer(dir, { action_id: id, choice: "once", reason: REASON });
    assert.deepEqual(done, { outcome: "allowed", choice: "once", approval: "local_unverified", text: "Allowed once: rm -rf ../build (in /repo) · recorded on this computer" });
    const [made] = readAllowances(dir);
    assert.equal(made.once, true);
    assert.equal(made.approval, "local_unverified");
    assert.equal(readBlocked(dir).at(-1).acted, "allowed");
  } finally { await service.stop(); }
});

test("not connected to a workspace: a longer choice is refused, nothing is made, and once still works", async () => {
  const dir = computer();
  await blockActions(dir, [{ tool_name: "Bash", tool_input: { command: "rm -rf ../build" } }]);
  const id = readBlocked(dir).at(-1).id;
  const service = await serviceFor(dir);
  try {
    const { tray } = await callAgent(dir, "GET", "/tray", undefined, 10_000);
    const offers = tray.recent_blocks[0].offers;
    assert.deepEqual([offers.once, offers.fifteen, offers.always, offers.ask], [true, false, false, true], "only once (and asking) from here");
    for (const body of [{ choice: "always" }, { choice: "fifteen" }, { choice: "always", scope: "similar" }]) {
      const done = await answer(dir, { action_id: id, reason: REASON, ...body });
      assert.equal(done.outcome, body.scope ? "not_offered" : "needs_workspace", JSON.stringify(body));
      if (!body.scope) assert.equal(done.text, "This computer is not connected to a workspace, so it can only be allowed once from here.");
    }
    assert.deepEqual(readAllowances(dir), []);
    assert.deepEqual(readRequests(dir), []);
    assert.equal(readBlocked(dir).at(-1).acted, undefined, "still waiting for the person");
    assert.equal((await answer(dir, { action_id: id, choice: "once", reason: REASON })).outcome, "allowed");
  } finally { await service.stop(); }
});

test("the live question: always from the local channel becomes the hook's request; once reaches the hook marked local_unverified", async () => {
  const ws = await workspace();
  const dir = computer();
  connect(dir, ws.url);
  const service = await serviceFor(dir, { prompter: async () => ({ decision: "deny" }), promptWindow: false });
  try {
    const ask = async (id) => {
      const body = { action_id: id, rule: "destructive-shell", title: "Run a command that deletes data", summary: "rm -rf build", reason_min: 12,
        lasts: "this action only", timeout_ms: 20_000, mode: "override", offers: { allow: true, always: true, ask: true, fifteen: true }, harness: "claude", always_days: 30 };
      const waited = callAgent(dir, "POST", "/override/wait", { seen: null }, 25_000);
      await later(100);
      const hook = callAgent(dir, "POST", "/override", body, 25_000);
      const { question } = await waited;
      return { hook, question };
    };
    const first = await ask("act-live-000000000011");
    const pending = (await callAgent(dir, "GET", "/tray", undefined, 10_000)).tray.pending;
    assert.deepEqual([pending.offers.once, pending.offers.fifteen, pending.offers.always, pending.offers.ask], [true, false, false, true], "once, or asking an admin");
    // A tray that sends a longer choice anyway: it becomes the hook's request.
    const done = await callAgent(dir, "POST", "/override/answer", { action_id: first.question.action_id, choice: "always", reason: REASON }, 10_000);
    assert.equal(done.outcome, "asked");
    assert.equal(done.requested, "always");
    assert.equal(done.allowed_once, false);
    assert.deepEqual(await first.hook, { decision: "ask", reason: REASON, os_user: (await import("node:os")).userInfo().username }, "the hook hears a request, never an allow");
    const second = await ask("act-live-000000000012");
    assert.equal((await callAgent(dir, "POST", "/override/answer", { action_id: second.question.action_id, choice: "once", reason: REASON }, 10_000)).approval, "local_unverified");
    const allowed = await second.hook;
    assert.equal(allowed.decision, "allow");
    assert.equal(allowed.lasts, "once");
    assert.equal(allowed.approval, "local_unverified");
  } finally { await service.stop(); ws.server.close(); }
});

test("the live question, not connected: a longer choice is refused and the question keeps waiting", async () => {
  const dir = computer();
  const service = await serviceFor(dir, { prompter: async () => ({ decision: "deny" }), promptWindow: false });
  try {
    const body = { action_id: "act-live-000000000021", rule: "destructive-shell", title: "Run a command that deletes data", summary: "rm -rf build", reason_min: 12,
      lasts: "this action only", timeout_ms: 20_000, mode: "override", offers: { allow: true, always: true, ask: true, fifteen: true }, harness: "claude" };
    const waited = callAgent(dir, "POST", "/override/wait", { seen: null }, 25_000);
    await later(100);
    const hook = callAgent(dir, "POST", "/override", body, 25_000);
    const { question } = await waited;
    const refused = await callAgent(dir, "POST", "/override/answer", { action_id: question.action_id, choice: "always", reason: REASON }, 10_000);
    assert.equal(refused.outcome, "needs_workspace");
    assert.equal((await callAgent(dir, "GET", "/tray", undefined, 10_000)).tray.pending.action_id, question.action_id, "still waiting");
    await callAgent(dir, "POST", "/override/answer", { action_id: question.action_id, choice: "once", reason: REASON }, 10_000);
    assert.equal((await hook).lasts, "once");
  } finally { await service.stop(); }
});
