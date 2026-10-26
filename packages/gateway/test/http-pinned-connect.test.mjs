// When an enforced endpoint_denylist lists an address, the HTTP executor resolves a host name and refuses it if any
// address it resolves to is denied. The connection then goes to the addresses that check approved: the name is never
// resolved a second time, so a resolver that answers the check with an allowed address and the connection with a
// denied one (DNS rebinding) cannot send the call to the denied address. The request still names the host, so the
// Host header (and for HTTPS the server name and certificate) are for the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import http from "node:http";
import { createHttpExecutor } from "../dist/index.js";

const DENIED = "192.0.2.66";
const policy = { vocabulary_version: "1.0", policy_id: "deny", version: 1, clauses: [
  { id: "no-internal", type: "endpoint_denylist", mode: "enforce", hosts: [DENIED] },
] };

test("a name resolved to an allowed address for the check is connected to at that address, never resolved again", async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push({ host: req.headers.host, url: req.url }); res.end("ok"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = server.address().port;

  // The resolver the check uses: the allowed address first, the denied one on every later question.
  let checks = 0;
  const lookup = async () => (checks++ === 0 ? [{ address: "127.0.0.1", family: 4 }] : [{ address: DENIED, family: 4 }]);
  // The system resolver a second lookup would use answers with the denied address too.
  const systemAsked = [];
  const original = dns.lookup;
  dns.lookup = function (hostname, options, callback) {
    const cb = typeof options === "function" ? options : callback;
    const all = typeof options === "object" && options?.all;
    if (hostname === "rebind.test") { systemAsked.push(hostname); return all ? cb(null, [{ address: DENIED, family: 4 }]) : cb(null, DENIED, 4); }
    return original.call(this, hostname, options, callback);
  };
  t.after(() => { dns.lookup = original; });

  const executor = createHttpExecutor({ scheme: "http", lookup, timeoutMs: 1500 });
  const intent = { action_type: "http.call", params: { host: `rebind.test:${port}`, path: "/status", method: "GET" } };
  let outcome;
  try { outcome = await executor.execute(intent, { actionId: "action:rebind", policy }); }
  catch (error) { outcome = { error: `${error.name}: ${error.message}` }; }

  assert.deepEqual(systemAsked, [], "the name was not resolved a second time");
  assert.equal(checks, 1, "the check resolved the name once");
  assert.match(outcome.ref ?? JSON.stringify(outcome), /^http:200:sha256:/);
  assert.deepEqual(seen, [{ host: `rebind.test:${port}`, url: "/status" }], "the checked address got the request, for the name");
});

test("a pinned call answered with a redirect fails, as fetch with redirect: error does", async (t) => {
  const server = http.createServer((_req, res) => { res.writeHead(302, { location: "http://elsewhere.test/" }); res.end(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const executor = createHttpExecutor({ scheme: "http", lookup: async () => [{ address: "127.0.0.1", family: 4 }], timeoutMs: 5000 });
  const intent = { action_type: "http.call", params: { host: `pinned.test:${server.address().port}`, path: "/", method: "POST", body: "x" } };
  await assert.rejects(executor.execute(intent, { actionId: "action:redirect", policy }), /redirect/);
});
