// `intel show`: what the next upload of records will contain. It runs the uploader itself against a copy of the queue, so it
// shows exactly the bodies a delivery sends, changes nothing in the queue, shows a plugin's slot only as its size (its base64
// with --raw), and masks secrets in what it prints.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCloudExporter } from "@scopebond/gateway";
import {
  createHookRuntime, exporterOptions, loadConnection, mapClaudeToolUse, openDeliveryQueue, pluginFrom, scaffold, OUTBOX_FILE,
} from "../dist/index.js";
import { ENFORCE } from "./enforce-all.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const SLOT = Buffer.from("an opaque slot the hook never reads").toString("base64");

/** A connected folder whose queue holds the records of these calls (and, with `slot`, a plugin's slot on each). */
async function connectedWithRecords(calls, { detail = "full", slot = false, enforce = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sb-intel-show-"));
  scaffold(dir, enforce ? ENFORCE : {});
  writeFileSync(join(dir, "cloud.json"), JSON.stringify({ url: "https://ws.example", credential: "sbm_test_credential_value", credential_id: "cred_1" }));
  writeFileSync(join(dir, "managed-meta.json"), JSON.stringify({ evidence_detail: detail }));
  const runtime = createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"),
    context: { harness: "claude", harness_version: "2.1.0", model: null, session_id: "s-1", repository: null, branch: null },
    ...(slot ? { intel: pluginFrom("1.0.0", () => ({ slot: SLOT })) } : {}),
  });
  const queue = openDeliveryQueue(join(dir, OUTBOX_FILE));
  const receipts = [];
  try {
    for (const call of calls) {
      const actions = Array.isArray(call) ? call : mapClaudeToolUse({ ...call, cwd: dir });
      const decision = await runtime.evaluate(actions);
      for (const receipt of decision.receipts ?? [decision.receipt]) { receipts.push(receipt); queue.enqueue(receipt); }
    }
  } finally { runtime.close(); queue.close(); }
  return { dir, receipts };
}

function show(dir, args = []) {
  const home = mkdtempSync(join(tmpdir(), "sb-intel-show-home-"));
  return spawnSync(process.execPath, [cli, "intel", "show", ...args], {
    cwd: dir, encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, SCOPEBOND_HOME: home, SCOPEBOND_HOOK_DIR: dir, SCOPEBOND_POLICY_SYNC: "off" },
  });
}

const pending = (dir) => { const q = openDeliveryQueue(join(dir, OUTBOX_FILE)); try { return q.status().pending; } finally { q.close(); } };

/** What a real delivery from this folder sends now: the same uploader, with a workspace that accepts everything. */
async function delivered(dir) {
  const bodies = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push({ route: new URL(url).pathname, body });
    return new Response(JSON.stringify({ accepted: (body.receipts ?? body.summaries).length }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const queue = openDeliveryQueue(join(dir, OUTBOX_FILE));
  const exporter = createCloudExporter({ ...exporterOptions(join(dir, OUTBOX_FILE), loadConnection(dir), queue, fetch), flushMs: 1e9 });
  // stop() closes the queue too.
  try { await exporter.flush(); } finally { exporter.stop(); }
  return bodies;
}

test("queued records: the bodies are exactly what the uploader sends, and the queue is left as it was", async () => {
  const { dir, receipts } = await connectedWithRecords([
    { tool_name: "Bash", tool_input: { command: "npm test" } },
    { tool_name: "Write", tool_input: { file_path: "src/app.ts" } },
    { tool_name: "Bash", tool_input: { command: "git push origin feature/x" } },
  ], { slot: true });
  const before = pending(dir);
  const raw = show(dir, ["--json", "--raw"]);
  assert.equal(raw.status, 0, raw.stderr);
  const preview = JSON.parse(raw.stdout);
  assert.equal(pending(dir), before, "nothing left the queue");
  assert.equal(preview.connected, true);
  assert.equal(preview.workspace, "https://ws.example");
  assert.equal(preview.queued, receipts.length);
  assert.deepEqual(preview.uploads.map((u) => u.route), ["/v1/ingest"]);
  assert.deepEqual(Object.keys(preview.uploads[0].body).sort(), ["queue", "receipts", "seq", "seq_proof"]);
  assert.deepEqual(preview.uploads[0].body.receipts, JSON.parse(JSON.stringify(receipts)));
  // A real delivery afterwards sends the same body, byte for byte as JSON (the record numbers and their signed proof too).
  const sent = await delivered(dir);
  assert.deepEqual(sent.map((s) => s.route), ["/v1/ingest"]);
  assert.deepEqual(preview.uploads[0].body, sent[0].body);
  assert.equal(pending(dir), 0, "that delivery did take them");
});

test("the plugin slot is shown as its size, and its base64 only with --raw", async () => {
  const { dir } = await connectedWithRecords([{ tool_name: "Bash", tool_input: { command: "ls" } }], { slot: true });
  const json = JSON.parse(show(dir, ["--json"]).stdout);
  const bytes = Buffer.from(SLOT, "base64").length;
  for (const receipt of json.uploads[0].body.receipts) assert.equal(receipt.payload.intel, `<opaque, ${bytes} bytes>`);
  assert.equal(json.categories.with_slot, json.uploads[0].body.receipts.length);
  const text = show(dir);
  assert.equal(text.status, 0, text.stderr);
  assert.ok(text.stdout.includes(`"intel": "<opaque, ${bytes} bytes>"`));
  assert.ok(!text.stdout.includes(SLOT), "the slot's bytes are not printed without --raw");
  const raw = show(dir, ["--raw"]);
  assert.ok(raw.stdout.includes(SLOT));
  assert.match(raw.stdout, /\(base64\): /);
});

test("the categories: action kinds, parameters, rule results and rules, coding tools, counts", async () => {
  const { dir } = await connectedWithRecords([
    { tool_name: "Bash", tool_input: { command: "git push origin main" } },
    { tool_name: "Read", tool_input: { file_path: "README.md" } },
  ], { enforce: true });
  const json = JSON.parse(show(dir, ["--json"]).stdout);
  const c = json.categories;
  assert.equal(c.requests, 1);
  assert.equal(c.records, json.uploads[0].body.receipts.length);
  assert.equal(c.bytes, json.uploads[0].bytes);
  assert.equal(c.action_kinds["git.push"], 1);
  assert.equal(c.action_kinds["file.read"], 1);
  assert.ok(c.parameters.ref >= 1 && c.parameters.path >= 1);
  assert.equal(c.rule_results.deny >= 1, true);
  assert.equal(c.rules["protect-branches"], 1);
  assert.deepEqual(Object.keys(c.coding_tools), ["claude"]);
  assert.equal(c.with_slot, 0);
  const text = show(dir).stdout;
  assert.match(text, /^The next upload to https:\/\/ws\.example: 1 request, \d+ bytes \(\d+ records queued\)\./m);
  assert.match(text, /action kinds +.*git\.push 1/);
  assert.match(text, /rule results +.*\(rules matched: protect-branches 1\)/);
  assert.match(text, /coding tools +claude \d+/);
  assert.match(text, /plugin slot +no record carries one/);
});

test("standard detail: routine records wait for their summary window, a block goes at once", async () => {
  const { dir } = await connectedWithRecords([
    { tool_name: "Bash", tool_input: { command: "npm test" } },
    { tool_name: "Bash", tool_input: { command: "git push origin main" } },
  ], { detail: "standard", enforce: true });
  const json = JSON.parse(show(dir, ["--json"]).stdout);
  const sent = json.uploads.flatMap((u) => u.body.receipts ?? []);
  assert.ok(sent.length >= 1 && sent.every((r) => r.payload.realtime_result === "deny"), "only the block goes now");
  assert.ok(json.held.routine >= 1);
  assert.match(show(dir).stdout, /held +\d+ routine records? waits? for its summary window/);
});

test("secrets in a recorded value are masked on the screen", async () => {
  const fetchWithToken = [{ intent: { action_type: "net.fetch", params: { host: "api.example.com", path: "/v1/items?token=s3cr3tvalue12345&page=2" } }, evaluated: true, source: "shell" }];
  const { dir } = await connectedWithRecords([fetchWithToken]);
  for (const args of [[], ["--json"], ["--json", "--raw"]]) {
    const out = show(dir, args);
    assert.equal(out.status, 0, out.stderr);
    assert.ok(!out.stdout.includes("s3cr3tvalue12345"), `no secret with ${args.join(" ") || "no flags"}`);
    assert.ok(!out.stdout.includes("sbm_test_credential_value"), "never the credential");
  }
  assert.match(show(dir, ["--json"]).stdout, /token=\*\*\*/);
});

test("nothing queued, or not connected: it says so and shows the fields one record carries", async () => {
  const { dir } = await connectedWithRecords([]);
  const text = show(dir);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^Nothing is waiting to be sent to https:\/\/ws\.example\./m);
  assert.match(text.stdout, /One record carries these fields/);
  assert.match(text.stdout, /"action_type": "shell\.exec"/);
  const json = JSON.parse(show(dir, ["--json"]).stdout);
  assert.deepEqual(json.uploads, []);
  assert.equal(json.queued, 0);
  assert.equal(json.example.payload.intent.action_type, "shell.exec");
  assert.ok(json.example.payload.realtime_result);
  const alone = mkdtempSync(join(tmpdir(), "sb-intel-show-alone-"));
  scaffold(alone);
  const local = show(alone);
  assert.equal(local.status, 0, local.stderr);
  assert.match(local.stdout, /not connected to a Scopebond Cloud workspace: nothing is uploaded/);
  assert.equal(JSON.parse(show(alone, ["--json"]).stdout).connected, false);
  const home = mkdtempSync(join(tmpdir(), "sb-intel-show-home-"));
  assert.equal(spawnSync(process.execPath, [cli, "intel"], { cwd: alone, encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home, SCOPEBOND_HOME: home, SCOPEBOND_HOOK_DIR: alone } }).status, 1, "usage");
});
