// The Scopebond window offers only the choices the workspace allows, and the agent sends a person's allowances
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
import { sendAllowancesAndRequests, ALLOWANCE_DOMAIN, REQUEST_DOMAIN } from "../dist/allowance-sender.js";

const question = (extra = {}) => ({ action_id: "act-0123456789abcdef", rule: "destructive-shell", title: "Run a command that deletes data or shuts down the computer", summary: "rm -rf build", reason_min: 10, lasts: "this action only", timeout_ms: 45_000, ...extra });
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

test("the window offers what the rule allows: allow (once, 15 minutes, always) or ask to unblock", () => {
  const legacy = parseQuestion(question());
  assert.deepEqual(legacy.offers, { allow: true, always: false, ask: false }, "an older hook's question still gets Allow once");
  const full = parseQuestion(question({ mode: "override", offers: { allow: true, always: true, ask: true } }));
  const script = windowsScript(full);
  for (const label of ["Allow once", "Allow for 15 min", "Always allow this here…", "Ask to unblock", "Don't allow"]) assert.ok(script.includes(b64(label)), label);
  const asking = parseQuestion(question({ mode: "ask", offers: { allow: true, always: true, ask: true } }));
  assert.deepEqual(asking.offers, { allow: false, always: false, ask: true, fifteen: false }, "'Block, person may ask' never allows on the spot");
  const noFifteen = windowsScript(parseQuestion(question({ mode: "override", offers: { allow: true, always: false, ask: false, fifteen: false } })));
  assert.ok(!noFifteen.includes(b64("Allow for 15 min")), "15 minutes only where the workspace knows allowances");
  const askScript = windowsScript(asking);
  assert.ok(askScript.includes(b64("Ask to unblock")));
  assert.ok(!askScript.includes(b64("Allow once")));
  assert.match(questionText(asking), /ask to unblock it; an admin decides/);
});

test("allowances and requests a person made are sent once, signed by the computer's key; a refusal is not retried", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-allow-send-"));
  const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
  const allowance = makeAllowance({ rule: "destructive-shell", actionKey: "a".repeat(64), reason: "release clean-up step", osUserDigest: null, lasts: "always" });
  const refused = makeAllowance({ rule: "destructive-shell", actionKey: "b".repeat(64), reason: "something the workspace refuses", osUserDigest: null, lasts: "always" });
  writeAllowances(dir, [allowance, refused]);
  queueRequest(dir, { rule: "destructive-shell", action_key: "c".repeat(64), action_id: "act-0123456789abcdef", summary: "rm -rf build", reason: "need it for the release", os_user_digest: null, harness: "claude" });
  const posts = [];
  let addedDuringSend = false;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    posts.push({ path: new URL(url).pathname, body });
    const domain = new URL(url).pathname === "/v1/allowances" ? ALLOWANCE_DOMAIN : REQUEST_DOMAIN;
    const signedBytes = Buffer.from(domain + canonical(body.record));
    const ok = verify(null, signedBytes, createPublicKey(attester.publicKeyPem), Buffer.from(body.signature, "base64url"))
      || verify(null, signedBytes, createPublicKey(attester.publicKeyPem), Buffer.from(body.signature, "base64"));
    assert.ok(ok, "signed by the enrolled key over its domain line");
    // The hook adds an allowance while this send is waiting: it survives the write.
    if (posts.length === 1 && !addedDuringSend) addedDuringSend = true, writeAllowances(dir, [...readAllowances(dir), makeAllowance({ rule: "destructive-shell", actionKey: "d".repeat(64), reason: "made while sending, keep me", osUserDigest: null, lasts: "15m" })]);
    assert.equal(body.kid, attester.kid);
    return new Response("{}", { status: body.record.id === refused.id ? 400 : 200 });
  };
  const connection = { url: "https://cloud.example.test", credential: "sbm_x" };
  assert.deepEqual(await sendAllowancesAndRequests(dir, connection, fetchImpl), { allowances: 1, requests: 1, ended: 0 });
  assert.ok(readAllowances(dir).some((a) => a.action_key === "d".repeat(64)), "an allowance made during the send is kept");
  assert.deepEqual(posts.map((p) => p.path).sort(), ["/v1/allowances", "/v1/allowances", "/v1/requests"]);
  assert.equal(posts.find((p) => p.body.record.id === allowance.id).body.record.reason, "release clean-up step", "the workspace gets the text");
  assert.ok(readAllowances(dir).filter((a) => a.action_key !== "d".repeat(64)).every((a) => a.sent_at), "both settled");
  assert.equal(readAllowances(dir).find((a) => a.id === allowance.id).reason, undefined, "the computer keeps only the digest once sent");
  assert.ok(readRequests(dir)[0].sent_at);
  posts.length = 0;
  assert.deepEqual(await sendAllowancesAndRequests(dir, connection, fetchImpl), { allowances: 1, requests: 0, ended: 0 }, "only the one made during the first send goes now");
  posts.length = 0;
  assert.deepEqual(await sendAllowancesAndRequests(dir, connection, fetchImpl), { allowances: 0, requests: 0, ended: 0 });
  assert.equal(posts.length, 0, "nothing is sent twice");
});

test("where the workspace sets one length, the window offers only it", () => {
  const fixed = parseQuestion(question({ mode: "override", offers: { allow: false, always: false, ask: false, fifteen: true } }));
  const script = windowsScript(fixed);
  assert.ok(script.includes(b64("Allow for 15 min")));
  assert.ok(!script.includes(b64("Allow once")) && !script.includes(b64("Always allow this here…")));
  assert.doesNotMatch(questionText(fixed), /ask an admin/, "it may be allowed, not only asked about");
});

test("stop allowing: the ended record goes to the workspace once, signed by the computer's key; a refusal is not retried", async () => {
  const { endAllowance, matchAllowance } = await import("@scopebond/hook");
  const { endedRecord } = await import("../dist/allowance-sender.js");
  const dir = mkdtempSync(join(tmpdir(), "sb-allow-end-"));
  const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
  const made = makeAllowance({ rule: "destructive-shell", actionKey: "a".repeat(64), reason: "release clean-up step", osUserDigest: null, lasts: "always" });
  const refusedOne = makeAllowance({ rule: "destructive-shell", actionKey: "b".repeat(64), reason: "another clean-up step", osUserDigest: null, lasts: "15m" });
  writeAllowances(dir, [made, refusedOne]);
  assert.deepEqual(endAllowance(dir, made.id), { outcome: "ended" });
  assert.deepEqual(endAllowance(dir, made.id), { outcome: "gone" }, "once");
  assert.equal(matchAllowance(readAllowances(dir), { rule: "destructive-shell", actionKey: "a".repeat(64), osUserDigest: null, now: Date.now() }), null, "it no longer applies");
  const posts = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    posts.push(body.record);
    const ok = verify(null, Buffer.from(ALLOWANCE_DOMAIN + canonical(body.record)), createPublicKey(attester.publicKeyPem), Buffer.from(body.signature, "base64url"))
      || verify(null, Buffer.from(ALLOWANCE_DOMAIN + canonical(body.record)), createPublicKey(attester.publicKeyPem), Buffer.from(body.signature, "base64"));
    assert.ok(ok, "signed over the allowance domain");
    return new Response("{}", { status: body.record.state === "ended" && body.record.id === refusedOne.id ? 400 : 200 });
  };
  const connection = { url: "https://cloud.example.test", credential: "sbm_x" };
  // First the allowances themselves (their record never carries the ending), then the ended one.
  assert.deepEqual(await sendAllowancesAndRequests(dir, connection, fetchImpl), { allowances: 2, requests: 0, ended: 1 });
  const created = posts.filter((r) => r.state !== "ended");
  assert.equal(created.length, 2);
  for (const r of created) assert.ok(!("ended_at" in r) && !("ended_by" in r) && !("end_sent_at" in r));
  const ended = posts.find((r) => r.state === "ended");
  assert.deepEqual(Object.keys(ended).sort(), ["ended_at", "ended_by", "id", "state"]);
  assert.deepEqual(ended, endedRecord(readAllowances(dir).find((a) => a.id === made.id)));
  assert.equal(ended.ended_by, "person");
  assert.ok(readAllowances(dir).find((a) => a.id === made.id).end_sent_at);
  // The other is ended now; its workspace refuses the record (an older workspace): not sent again, still ended here.
  endAllowance(dir, refusedOne.id);
  assert.deepEqual(await sendAllowancesAndRequests(dir, connection, fetchImpl), { allowances: 0, requests: 0, ended: 0 });
  const before = posts.length;
  assert.deepEqual(await sendAllowancesAndRequests(dir, connection, fetchImpl), { allowances: 0, requests: 0, ended: 0 });
  assert.equal(posts.length, before, "not retried");
  assert.ok(readAllowances(dir).find((a) => a.id === refusedOne.id).ended_at);
});
