// What @scopebond/framework sends to Cloud for a wrapped tool call. The guard's receipt keeps the tool's arguments, but
// credential-shaped values inside them (a token in a URL query, a password literal in SQL, a Bearer header in a shell
// command) are scrubbed before the receipt is signed and exported, as well as values under credential-named keys.
// Fake values only, assembled at run time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolGuard } from "../dist/index.js";

const edPem = () => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const policy = { vocabulary_version: "1.0", policy_id: "agent", version: 1, clauses: [{ id: "t", type: "action_allowlist", mode: "enforce", action_types: ["tool.http_get", "tool.run_sql", "tool.send_email", "tool.shell", "payout.create"] }] };

function capture() {
  const posted = [];
  const fetch = async (url, init) => { posted.push({ url: String(url), body: String(init?.body ?? "") }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); };
  return { posted, fetch, ingest: () => posted.filter((p) => p.url.endsWith("/v1/ingest")).map((p) => p.body).join("\n") };
}

test("the framework guard scrubs credential shapes inside tool arguments before they reach /v1/ingest", async () => {
  const cloud = capture();
  const guard = createToolGuard({ policy, agentKeyPem: edPem(), attesterKeyPem: edPem(), cloud: { connection: { url: "https://cloud.invalid", credential: "sbm_fake" }, fetch: cloud.fetch } });
  const tok = ["FAKE", "tok", "Qz9", "x".repeat(20)].join("");
  const pw = ["Pw", "Fake", "Qz9", "hunter"].join("");
  const bearer = ["FAKE", "bearer", "Qz9", "y".repeat(20)].join("");
  const bearer2 = ["FAKE", "shellbr", "Qz8", "w".repeat(20)].join("");
  const cases = {
    url_query_token: ["http_get", { url: `https://api.example.test/v1/data?api_token=${tok}` }, tok],
    header_by_key: ["http_get", { url: "https://api.example.test/", headers: { Authorization: `Bearer ${bearer}` } }, bearer],
    sql_literal: ["run_sql", { query: `ALTER USER app PASSWORD '${pw}'` }, pw],
    email_body_text: ["send_email", { to: "x@example.test", body: "diagnosis for Mary Sample" }, "diagnosis for Mary Sample"],
    shell_bearer: ["shell", { command: `curl -H "Authorization: Bearer ${bearer2}" https://x.example.test` }, bearer2],
  };
  for (const [, [tool, args]] of Object.entries(cases)) await guard.check(tool, args);
  await guard.flush();
  guard.stop();
  const text = cloud.ingest();
  assert.ok(text.length > 0, "the guard POSTed /v1/ingest");
  const verdict = Object.fromEntries(Object.entries(cases).map(([k, [, , secret]]) => [k, text.includes(secret) ? "clear" : "redacted"]));
  assert.deepEqual(verdict, { url_query_token: "redacted", header_by_key: "redacted", sql_literal: "redacted", email_body_text: "redacted", shell_bearer: "redacted" });
});

test("ordinary arguments and the money fields stay in clear", async () => {
  const cloud = capture();
  const guard = createToolGuard({ policy, agentKeyPem: edPem(), attesterKeyPem: edPem(), manifest: { pay: "payout.create" }, cloud: { connection: { url: "https://cloud.invalid", credential: "sbm_fake" }, fetch: cloud.fetch } });
  await guard.check("pay", { asset: "USDC", amount: 1200, memo: "invoice 42" });
  await guard.check("http_get", { url: "https://api.example.test/v1/data?page=2" });
  await guard.flush();
  guard.stop();
  const receipts = cloud.posted.flatMap((p) => JSON.parse(p.body).receipts ?? []);
  const intents = receipts.map((r) => r.payload.intent);
  assert.deepEqual(intents[0].params, { asset: "USDC", amount: 1200, memo: "invoice 42" });
  assert.equal(intents[0].asset, "USDC");
  assert.equal(intents[0].amount, 1200);
  assert.equal(intents[1].params.url, "https://api.example.test/v1/data?page=2");
});

test("a durable outbox path keeps queued receipts across a restart without a gap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-fw-outbox-"));
  const outboxPath = join(dir, "outbox.db");
  const agentKeyPem = edPem(), attesterKeyPem = edPem();
  const down = async () => new Response("{}", { status: 503 });
  const gaps = [];
  const first = createToolGuard({ policy, agentKeyPem, attesterKeyPem, cloud: { connection: { url: "https://cloud.invalid", credential: "sbm_fake" }, fetch: down, outboxPath, onGap: (g) => gaps.push(g) } });
  await first.check("http_get", { url: "https://api.example.test/a" });
  await first.check("http_get", { url: "https://api.example.test/b" });
  await first.flush();
  first.stop();
  const cloud = capture();
  const second = createToolGuard({ policy, agentKeyPem, attesterKeyPem, cloud: { connection: { url: "https://cloud.invalid", credential: "sbm_fake" }, fetch: cloud.fetch, outboxPath } });
  await second.flush();
  second.stop();
  const delivered = cloud.posted.flatMap((p) => JSON.parse(p.body).receipts ?? []);
  assert.equal(delivered.length, 2, "both receipts queued before the restart were delivered after it");
  assert.deepEqual(gaps, []);
});
