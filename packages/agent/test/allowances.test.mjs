// D144 (SB411): the Scopebond window offers only the choices the workspace allows, and the agent sends a person's allowances
// and requests to the workspace once, signed by the computer's enrolled key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical } from "@scopebond/gateway";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { makeAllowance, queueRequest, readAllowances, readRequests, writeAllowances } from "@scopebond/hook";
import { createPublicKey, verify } from "node:crypto";
import { parseQuestion, questionText, windowsScript } from "../dist/prompt.js";
import { sendAllowancesAndRequests } from "../dist/allowance-sender.js";

const question = (extra = {}) => ({ action_id: "act-0123456789abcdef", rule: "destructive-shell", title: "Destructive command", summary: "rm -rf build", reason_min: 10, lasts: "this action only", timeout_ms: 45_000, ...extra });
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

test("the window offers what the rule allows: allow (once, 15 minutes, always) or Ask an admin", () => {
  const legacy = parseQuestion(question());
  assert.deepEqual(legacy.offers, { allow: true, always: false, ask: false }, "an older hook's question still gets Allow once");
  const full = parseQuestion(question({ mode: "override", offers: { allow: true, always: true, ask: true } }));
  const script = windowsScript(full);
  for (const label of ["Allow once", "Allow for 15 min", "Always allow this here…", "Ask an admin", "Don't allow"]) assert.ok(script.includes(b64(label)), label);
  const asking = parseQuestion(question({ mode: "ask", offers: { allow: true, always: true, ask: true } }));
  assert.deepEqual(asking.offers, { allow: false, always: false, ask: true }, "'Block, person may ask' never allows on the spot");
  const askScript = windowsScript(asking);
  assert.ok(askScript.includes(b64("Ask an admin")));
  assert.ok(!askScript.includes(b64("Allow once")));
  assert.match(questionText(asking), /ask an admin to allow it/);
});

test("allowances and requests a person made are sent once, signed by the computer's key; a refusal is not retried", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-allow-send-"));
  const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
  const allowance = makeAllowance({ rule: "destructive-shell", actionKey: "a".repeat(64), reason: "release clean-up step", osUserDigest: null, lasts: "always" });
  const refused = makeAllowance({ rule: "destructive-shell", actionKey: "b".repeat(64), reason: "something the workspace refuses", osUserDigest: null, lasts: "always" });
  writeAllowances(dir, [allowance, refused]);
  queueRequest(dir, { rule: "destructive-shell", action_key: "c".repeat(64), action_id: "act-0123456789abcdef", summary: "rm -rf build", reason: "need it for the release", os_user_digest: null, harness: "claude" });
  const posts = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    posts.push({ path: new URL(url).pathname, body });
    const ok = verify(null, Buffer.from(canonical(body.record)), createPublicKey(attester.publicKeyPem), Buffer.from(body.signature, "base64url"))
      || verify(null, Buffer.from(canonical(body.record)), createPublicKey(attester.publicKeyPem), Buffer.from(body.signature, "base64"));
    assert.ok(ok, "signed by the enrolled key");
    assert.equal(body.kid, attester.kid);
    return new Response("{}", { status: body.record.id === refused.id ? 400 : 200 });
  };
  const connection = { url: "https://cloud.example.test", credential: "sbm_x" };
  assert.deepEqual(await sendAllowancesAndRequests(dir, connection, fetchImpl), { allowances: 1, requests: 1 });
  assert.deepEqual(posts.map((p) => p.path).sort(), ["/v1/allowances", "/v1/allowances", "/v1/requests"]);
  assert.equal(posts.find((p) => p.body.record.id === allowance.id).body.record.reason, "release clean-up step", "the workspace gets the text");
  assert.ok(readAllowances(dir).every((a) => a.sent_at), "both settled");
  assert.equal(readAllowances(dir).find((a) => a.id === allowance.id).reason, undefined, "the computer keeps only the digest once sent");
  assert.ok(readRequests(dir)[0].sent_at);
  posts.length = 0;
  assert.deepEqual(await sendAllowancesAndRequests(dir, connection, fetchImpl), { allowances: 0, requests: 0 });
  assert.equal(posts.length, 0, "nothing is sent twice");
});
