// submit() against a faulty or intermediary gateway: it must never read an error as an allow,
// and it must not wait forever.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createSigner, submit } from "../dist/index.js";

const serve = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => resolve(s)); });
const signed = () => createSigner().sign({ action_type: "tool.x", params: {} });
const url = (s) => `http://127.0.0.1:${s.address().port}`;
const answer = (status, body) => (_q, r) => { r.writeHead(status, { "content-type": "application/json" }); r.end(body); };

test("submit() rejects when the gateway is unreachable or answers non-JSON", async () => {
  await assert.rejects(submit("http://127.0.0.1:9", signed()));
  const s = await serve((_q, r) => { r.writeHead(502, { "content-type": "text/html" }); r.end("<html>bad gateway</html>"); });
  try { await assert.rejects(submit(url(s), signed())); } finally { s.close(); }
});

test("submit() rejects a non-2xx answer that is not an explicit deny, and a non-boolean allowed", async () => {
  for (const [status, body] of [[500, '{"allowed":"false","reason":"error page"}'], [500, '{"allowed":true}'], [502, '{"error":"upstream"}'], [200, '{"allowed":"true"}'], [200, '{"allowed":1}'], [200, "null"]]) {
    const s = await serve(answer(status, body));
    try { await assert.rejects(submit(url(s), signed()), undefined, `${status} ${body}`); } finally { s.close(); }
  }
});

test("submit() returns an explicit deny (403, allowed false) and an allow", async () => {
  const deny = await serve(answer(403, '{"allowed":false,"reason":"out of policy","receipt":{}}'));
  try { assert.equal((await submit(url(deny), signed())).allowed, false); } finally { deny.close(); }
  const allow = await serve(answer(200, '{"allowed":true,"reason":"ok","receipt":{}}'));
  try { assert.equal((await submit(url(allow), signed())).allowed, true); } finally { allow.close(); }
});

test("submit() times out when the gateway never answers", async () => {
  const s = await serve(() => { /* never respond */ });
  try {
    const outcome = await Promise.race([
      submit(url(s), signed(), fetch, { timeoutMs: 300 }).then(() => "settled", () => "rejected"),
      new Promise((r) => setTimeout(() => r("still-pending"), 3000)),
    ]);
    assert.equal(outcome, "rejected");
  } finally { s.closeAllConnections?.(); s.close(); }
});
