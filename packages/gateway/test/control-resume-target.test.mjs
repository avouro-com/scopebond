// Lifting a stop must name what it lifts. A resume whose target is missing, misspelled, of the wrong type or not
// parseable is refused, so a typo during an incident cannot lift the global stop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGateway, StaticPrincipalKeyRegistry } from "../dist/index.js";
import { SqliteReceiptStore } from "../dist/node.js";
import { createSigner } from "@scopebond/sdk";

const TOKEN = "resume-target-control-token-000001";
const policy = {
  vocabulary_version: "1.0", policy_id: "resume", version: 1,
  clauses: [{ id: "tx", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 1000000 }],
};
const json = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const ctl = (init = {}) => ({ ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${TOKEN}` } });
const pay = (agent) => agent.sign({ action_type: "payout.create", asset: "USDC", amount: 100 });

function setup(dir, agents) {
  const keys = new StaticPrincipalKeyRegistry(agents.map((a) => ({ kid: a.kid, publicKeyPem: a.publicKeyPem, purposes: ["agent"], status: "active" })));
  const store = new SqliteReceiptStore(join(dir, "scopebond.db"));
  const gw = createGateway({ policy, store, authentication: { keys }, control: { bearerToken: TOKEN } });
  return { gw, store };
}

test("a resume whose target is malformed, misspelled or missing is refused and every stop stays in place", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-resume-"));
  const a = createSigner(); const b = createSigner();
  const { gw, store } = setup(dir, [a, b]);
  try {
    const cases = [
      ["agent as array", json({ agent: [a.kid] })],
      ["misspelled key", json({ agnet: a.kid })],
      ["unparseable JSON", json(`{agent: "${a.kid}"}`)],
      ["agent as number", json({ agent: 7 })],
      ["unknown key beside agent", json({ agent: a.kid, scope: "all" })],
      ["empty object", json({})],
      ["no body", { method: "POST" }],
      ["unknown target", json({ target: "everything" })],
    ];
    for (const [label, init] of cases) {
      // Incident state: everything stopped, and agent A individually stopped as well.
      await gw.app.request("/v1/kill", ctl(json({})));
      await gw.app.request("/v1/kill", ctl(json({ agent: a.kid })));
      const res = await gw.app.request("/v1/resume", ctl(init));
      const status = await (await gw.app.request("/v1/status", ctl())).json();
      const other = await gw.app.request("/v1/evaluate", json(pay(b)));
      assert.equal(res.status, 400, `${label}: refused`);
      assert.equal(status.killed, true, `${label}: the global stop stays`);
      assert.deepEqual(status.stopped_agents, [a.kid], `${label}: the agent stop stays`);
      assert.equal(other.status, 403, `${label}: other agents stay stopped`);
    }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a resume that names its target lifts exactly that stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-resume-"));
  const a = createSigner(); const b = createSigner();
  const { gw, store } = setup(dir, [a, b]);
  try {
    await gw.app.request("/v1/kill", ctl(json({})));
    await gw.app.request("/v1/kill", ctl(json({ agent: a.kid })));

    const one = await gw.app.request("/v1/resume", ctl(json({ agent: a.kid })));
    assert.equal(one.status, 200);
    assert.deepEqual(await one.json(), { killed: false, target: a.kid });
    let status = await (await gw.app.request("/v1/status", ctl())).json();
    assert.equal(status.killed, true, "lifting one agent leaves the global stop");
    assert.deepEqual(status.stopped_agents, []);

    const all = await gw.app.request("/v1/resume", ctl(json({ target: "global" })));
    assert.equal(all.status, 200);
    assert.deepEqual(await all.json(), { killed: false, target: "global" });
    status = await (await gw.app.request("/v1/status", ctl())).json();
    assert.equal(status.killed, false);
    assert.equal((await gw.app.request("/v1/evaluate", json(pay(b)))).status, 200);

    // An invalid agent id is still refused, whichever key names it.
    assert.equal((await gw.app.request("/v1/resume", ctl(json({ agent: "key:not-hex" })))).status, 400);
    assert.equal((await gw.app.request("/v1/resume", ctl(json({ target: "key:not-hex" })))).status, 400);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a kill with an unreadable body still stops everything (the safe direction)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-resume-"));
  const a = createSigner();
  const { gw, store } = setup(dir, [a]);
  try {
    for (const init of [{ method: "POST" }, json("{not json"), json({ agnet: a.kid }), json({ target: "global" })]) {
      await gw.app.request("/v1/resume", ctl(json({ target: "global" })));
      const res = await gw.app.request("/v1/kill", ctl(init));
      assert.equal(res.status, 200);
      assert.equal((await res.json()).target, "global");
      assert.equal((await (await gw.app.request("/v1/status", ctl())).json()).killed, true);
    }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
