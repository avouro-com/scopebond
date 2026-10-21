// Fault: this computer's credential is about to expire. Renewing it is Scopebond's job: the agent renews it silently, and
// tries again later when the workspace does not answer. Only when the workspace refuses the renewal must the person act:
// then, and only then, the tray says "Sign in again".
import { agent, computer, seen, serve, tray, until, workspace } from "./b2-fault-helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DAY = 86_400_000;
const cloud = (dir) => JSON.parse(readFileSync(join(dir, "cloud.json"), "utf8"));

test("three days left and the workspace renews: renewed silently, the tray stays Protected", async () => {
  const ws = workspace();
  const { dir } = computer({ expiresInDays: 3 });
  ws.answers.refresh = { refreshed: true, id: "cred-2", credential: "sbm_us_renewed", expires_at: new Date(Date.now() + 90 * DAY).toISOString() };
  const service = await serve(dir, ws);
  try {
    await until(() => cloud(dir).credential === "sbm_us_renewed", 10_000, "the credential renewed");
    assert.ok(Date.parse(cloud(dir).expires_at) - Date.now() > 80 * DAY);
    const m = seen(await tray(dir));
    assert.equal(m.state, "protected");
    assert.equal(m.fix, null);
  } finally { await service.stop(); }
});

test("the workspace does not answer the renewal (500): quiet, Protected, tried again later", async () => {
  const ws = workspace();
  const { dir } = computer({ expiresInDays: 3 });
  ws.faults.refresh = 500;
  const service = await serve(dir, ws);
  try {
    await until(() => ws.calls.refresh >= 1, 10_000, "a renewal tried");
    const m = seen(await tray(dir));
    assert.equal(m.state, "protected");
    assert.equal(m.fix, null);
  } finally { await service.stop(); }
});

test("the workspace refuses the renewal (401): the must-act Sign in again, which a new sign-in clears", async () => {
  const ws = workspace();
  const { dir, connection } = computer({ expiresInDays: 3 });
  ws.faults.refresh = 401;
  const service = await serve(dir, ws);
  try {
    await until(async () => (await tray(dir)).state === "attention", 10_000, "the person is asked to sign in again");
    const t = await tray(dir);
    assert.equal(t.headline, "Sign in again to keep this computer connected");
    assert.equal(t.fix?.id, "reconnect");
    assert.equal(t.fix?.label, "Sign in again…");
    // The person signed in again: a new credential.
    writeFileSync(join(dir, "cloud.json"), JSON.stringify({ ...connection, credential: "sbm_us_new", credential_id: "cred-3", expires_at: new Date(Date.now() + 90 * DAY).toISOString() }));
    await service.cycleNow();
    assert.equal(seen(await tray(dir)).state, "protected");
  } finally { await service.stop(); }
});

test("status says what the last renewal did", async () => {
  const ws = workspace();
  const { dir } = computer({ expiresInDays: 3 });
  ws.faults.refresh = 401;
  const service = await serve(dir, ws);
  try {
    await until(async () => (await agent.callAgent(dir, "GET", "/status", undefined, 5_000)).agent.credential_renewal?.outcome === "refused", 10_000, "recorded");
  } finally { await service.stop(); }
});
