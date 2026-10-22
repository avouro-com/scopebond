import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verify } from "node:crypto";
import { canonical, sha256 } from "@scopebond/gateway";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { createInventoryReporter, executionEnvironment, inventoryProof, INVENTORY_FILE } from "../dist/inventory.js";

const connection = { url: "https://workspace.example", credential: "test-credential", credential_id: "credential-a", organization_id: "org-a", environment_id: "env-a", gateway_id: "computer-a" };
const row = { harness: "codex", presence: "detected", integration: "not_configured", reason: "missing_entry", definition_revision: null };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

test("inventory negotiates, signs the actual report, strips diagnostics and does not send receipts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inventory-report-"));
  const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
  let calls = 0, now = 1_800_000_000_000, lastBody;
  const reporter = createInventoryReporter({ dir, connection: () => connection, now: () => now,
    execution: () => "windows", collect: () => [{ ...row, command: "private command", path: "private path", runtime: { state: "verified" } }],
    fetchImpl: async (url, init) => {
      calls++; assert.equal(url.pathname, "/v1/tool-inventory"); assert.equal(init.redirect, "error");
      assert.equal(init.headers.authorization, "Bearer test-credential");
      if (init.method !== "POST") return json({ capability: "tool_inventory_1", sequence: 10 });
      const body = lastBody = JSON.parse(init.body);
      assert.equal(body.report.sequence, 11);
      assert.equal(verify(null, Buffer.from(inventoryProof(connection, sha256(canonical(body.report)))), attester.publicKeyPem, Buffer.from(body.signature, "base64")), true);
      assert.equal(JSON.stringify(body).includes("private"), false);
      assert.equal(JSON.stringify(body).includes("verified"), false);
      return json({ ok: true, sequence: body.report.sequence });
    } });
  await reporter.reconcile();
  assert.equal(calls, 2); assert.equal(reporter.state().delivery, "reported");
  now += 10_000; await reporter.reconcile(); assert.equal(calls, 2);
  now += 60_000; await reporter.reconcile(); assert.equal(calls, 4);
  assert.equal(lastBody.report.observed_at, now);
  const disk = JSON.parse(readFileSync(join(dir, INVENTORY_FILE), "utf8"));
  assert.equal(disk.delivery, "reported"); assert.equal(JSON.stringify(disk).includes("test-credential"), false);
});

test("old Cloud and missing keys do not trigger unsigned or unsupported reports", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inventory-legacy-"));
  let calls = 0, now = 1_800_000_000_000;
  const reporter = createInventoryReporter({ dir, connection: () => connection, now: () => now, collect: () => [row],
    fetchImpl: async (_url, init) => { calls++; assert.notEqual(init.method, "POST"); return json({}, 404); } });
  await reporter.reconcile(); assert.equal(calls, 0); assert.equal(reporter.state().delivery, "signing_key_missing");
  loadOrCreateAttester({ file: join(dir, "attester.key") }); now += 6000;
  await reporter.reconcile(); assert.equal(calls, 1); assert.equal(reporter.state().delivery, "not_supported");
  now += 5000; await reporter.reconcile(); assert.equal(calls, 1);
});

test("a failed collection reports unknown, resumes independently, and recovers a server sequence after restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inventory-retry-"));
  loadOrCreateAttester({ file: join(dir, "attester.key") });
  let offline = true, now = 1_800_000_000_000, calls = 0;
  const options = { dir, connection: () => connection, now: () => now, collect: () => { throw new Error("private config unreadable"); },
    fetchImpl: async (_url, init) => {
      calls++; if (offline) throw new Error("offline");
      if (init.method !== "POST") return json({ capability: "tool_inventory_1", sequence: 40 });
      const body = JSON.parse(init.body);
      assert.equal(body.report.sequence, 41); assert.equal(body.report.collection, "failed"); assert.deepEqual(body.report.tools, []);
      assert.equal(init.body.includes("private"), false);
      return json({ ok: true, sequence: 41 });
    } };
  const first = createInventoryReporter(options); await first.reconcile();
  assert.equal(first.state().delivery, "retrying");
  now += 1000; await first.reconcile(); assert.equal(calls, 1);
  offline = false; now += 60_000; await first.reconcile(); assert.equal(first.state().delivery, "reported");
  const restarted = createInventoryReporter(options); await restarted.reconcile(); assert.equal(restarted.state().delivery, "reported");
});

test("re-enrollment resets report suppression and concurrent rescans do not overlap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inventory-scope-"));
  loadOrCreateAttester({ file: join(dir, "attester.key") });
  let current = connection, release, calls = 0;
  const reporter = createInventoryReporter({ dir, connection: () => current, collect: () => [row],
    fetchImpl: async (_url, init) => {
      calls++;
      if (init.method !== "POST") return new Promise((resolve) => { release = () => resolve(json({ capability: "tool_inventory_1", sequence: 0 })); });
      return json({ ok: true, sequence: 1 });
    } });
  const pending = reporter.reconcile(); await reporter.reconcile(); assert.equal(calls, 1);
  release(); await pending; assert.equal(calls, 2);
  current = { ...connection, organization_id: "org-b", gateway_id: "computer-b" };
  const second = reporter.reconcile(); assert.equal(calls, 3); release(); await second; assert.equal(calls, 4);
});

test("an oversized or incorrect acknowledgement cannot mark inventory delivered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inventory-bounds-"));
  loadOrCreateAttester({ file: join(dir, "attester.key") });
  for (const response of [() => json({ capability: "tool_inventory_1", sequence: -1 }), () => new Response("x".repeat(140 * 1024))]) {
    const reporter = createInventoryReporter({ dir, connection: () => connection, collect: () => [row], fetchImpl: async () => response() });
    await reporter.reconcile(); assert.equal(reporter.state().delivery, "retrying");
  }
});

test("execution boundaries report only categories and never copy environment values", () => {
  assert.equal(executionEnvironment("win32", {}), "windows");
  assert.equal(executionEnvironment("linux", { WSL_DISTRO_NAME: "private distro" }), "wsl");
  assert.equal(executionEnvironment("linux", { SSH_CONNECTION: "private address" }), "remote");
  assert.equal(executionEnvironment("linux", { container: "private container" }), "container");
});

test("a change within the throttle reports without another filesystem event; stop cancels pending work", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = mkdtempSync(join(tmpdir(), "inventory-throttle-"));
  loadOrCreateAttester({ file: join(dir, "attester.key") });
  let now = 1_800_000_000_000, present = "absent", posts = 0;
  const reporter = createInventoryReporter({ dir, connection: () => connection, now: () => now, collect: () => [{ ...row, presence: present }],
    fetchImpl: async (_url, init) => {
      if (init.method !== "POST") return json({ capability: "tool_inventory_1", sequence: posts });
      posts++; return json({ ok: true, sequence: posts });
    } });
  t.after(reporter.stop);
  await reporter.reconcile(); assert.equal(posts, 1);
  now += 1000; present = "detected"; await reporter.reconcile(); assert.equal(posts, 1);
  now += 4000; t.mock.timers.tick(4000);
  await new Promise(setImmediate); assert.equal(posts, 2);
  now += 1000; present = "absent"; await reporter.reconcile(); reporter.stop();
  now += 60_000; t.mock.timers.tick(60_000); await new Promise(setImmediate); assert.equal(posts, 2);
});
