// endpoint_denylist and the HTTP executor decide on the destination a request reaches, not on the text of its host:
// another spelling of a denied address (case, a trailing dot, a port, decimal/octal/hex IPv4, IPv6, IPv4-mapped IPv6),
// any loopback address for a denied loopback name or address, and a name that resolves to a denied address are all
// refused before anything is sent. Local only: one stub HTTP server on loopback, and an injected resolver.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createGateway, createHttpExecutor, StaticPrincipalKeyRegistry } from "../dist/index.js";
import { createSigner } from "@scopebond/sdk";

let server; let server6; let port; const seen = [];
const handler = (req, res) => { seen.push({ host: req.headers.host, url: req.url, remote: req.socket.remoteAddress }); res.end("ok"); };
before(async () => {
  // Loopback only: one listener on 127.0.0.1 and one on [::1] at the same port.
  server = createServer(handler);
  await new Promise((r) => server.listen({ port: 0, host: "127.0.0.1" }, r));
  port = server.address().port;
  server6 = createServer(handler);
  await new Promise((r) => { server6.once("error", () => { server6 = null; r(); }); server6.listen({ port, host: "::1", ipv6Only: true }, r); });
});
after(() => { server.close(); server6?.close(); });

function gatewayWith(hosts, executorOptions = { scheme: "http" }) {
  const policy = { vocabulary_version: "1.0", policy_id: "deny", version: 1, clauses: [
    { id: "no-internal", type: "endpoint_denylist", mode: "enforce", hosts },
  ] };
  const agent = createSigner();
  const keys = new StaticPrincipalKeyRegistry([{ kid: agent.kid, publicKeyPem: agent.publicKeyPem, purposes: ["agent"], status: "active" }]);
  const gw = createGateway({ policy, authentication: { keys }, executor: createHttpExecutor(executorOptions) });
  return { agent, gw };
}

const loopbackAliases = () => [
  `127.0.0.1:${port}`, `LOCALHOST:${port}`, `localhost.:${port}`, `localhost:${port}`, `sub.localhost:${port}`,
  `[::1]:${port}`, `[0:0:0:0:0:0:0:1]:${port}`, `[::ffff:7f00:1]:${port}`, `[::ffff:127.0.0.1]:${port}`, `[0:0:0:0:0:ffff:127.0.0.1]:${port}`,
  `2130706433:${port}`, `127.1:${port}`, `0x7f.1:${port}`, `0177.0.0.1:${port}`, `0x7f000001:${port}`, `127.0.0.2:${port}`,
  `0:${port}`, `0.0.0.0:${port}`, `[::]:${port}`,
];

test("a denied loopback name or address is not reached under another spelling, address family or port", async () => {
  for (const hosts of [[`127.0.0.1:${port}`, "127.0.0.1", "localhost"], ["127.0.0.1"], ["localhost"], ["[::1]"], [`localhost:${port}`]]) {
    const { agent, gw } = gatewayWith(hosts);
    for (const host of loopbackAliases()) {
      seen.length = 0;
      const r = await gw.handleAction(agent.sign({ action_type: "http.call", params: { host, path: "/", method: "GET" } }));
      assert.equal(r.allowed, false, `denylist ${JSON.stringify(hosts)} let ${host} through (${r.reason})`);
      assert.equal(seen.length, 0, `denylist ${JSON.stringify(hosts)}: ${host} reached the server`);
    }
  }
});

test("a port in a denylist entry is honoured; a host without a port may use the default HTTP or HTTPS port", async () => {
  const { agent, gw } = gatewayWith(["localhost:1"]);
  const r = await gw.handleAction(agent.sign({ action_type: "http.call", params: { host: `127.0.0.1:${port}`, path: "/", method: "GET" } }));
  assert.equal(r.allowed, true, "another port of a denied host:port is not denied");
  const fakeFetch = async () => ({ status: 200, text: async () => "ok" });
  for (const [entry, host, denied] of [["meta.example:443", "META.example.", true], ["meta.example:80", "meta.example", true], ["meta.example:8080", "meta.example", false], ["meta.example", "meta.example:8443", true]]) {
    const { agent: a, gw: g } = gatewayWith([entry], { fetch: fakeFetch, lookup: async () => [{ address: "192.0.2.10", family: 4 }] });
    const res = await g.handleAction(a.sign({ action_type: "http.call", params: { host, path: "/", method: "GET" } }));
    assert.equal(res.allowed, !denied, `${entry} vs ${host}`);
  }
});

test("a name that resolves to a denied address is refused before anything is sent", async () => {
  const dns = {
    "alias.example.test": [{ address: "127.0.0.1", family: 4 }],
    "mapped.example.test": [{ address: "::ffff:127.0.0.1", family: 6 }],
    "v6.example.test": [{ address: "::1", family: 6 }],
    "meta.example.test": [{ address: "169.254.169.254", family: 4 }],
    "mixed.example.test": [{ address: "192.0.2.10", family: 4 }, { address: "169.254.169.254", family: 4 }],
    "ok.example.test": [{ address: "192.0.2.10", family: 4 }],
  };
  const looked = [];
  const lookup = async (name) => { looked.push(name); if (!dns[name]) throw Object.assign(new Error(`ENOTFOUND ${name}`), { code: "ENOTFOUND" }); return dns[name]; };
  const calls = [];
  const fakeFetch = async (url) => { calls.push(String(url)); return { status: 200, text: async () => "ok" }; };
  const { agent, gw } = gatewayWith(["localhost", "169.254.169.254"], { fetch: fakeFetch, lookup });
  for (const host of ["alias.example.test", "mapped.example.test", "v6.example.test", "meta.example.test", "mixed.example.test"]) {
    const r = await gw.handleAction(agent.sign({ action_type: "http.call", params: { host, path: "/latest/meta-data", method: "GET" } }));
    assert.equal(calls.length, 0, `${host} was sent: ${calls.join(", ")}`);
    assert.equal(r.receipt.payload.execution.state, "failed", `${host}: ${r.receipt.payload.execution.state}`);
  }
  const ok = await gw.handleAction(agent.sign({ action_type: "http.call", params: { host: "ok.example.test", path: "/x", method: "GET" } }));
  assert.equal(ok.receipt.payload.execution.state, "executed");
  assert.deepEqual(calls, ["https://ok.example.test/x"]);
  assert.ok(looked.includes("ok.example.test"));
});

test("an allowlisted address is reached under its canonical form, and no other address is", async () => {
  const policy = { vocabulary_version: "1.0", policy_id: "egress", version: 1, clauses: [
    { id: "egress", type: "endpoint_allowlist", mode: "enforce", hosts: [`127.0.0.1:${port}`] },
  ] };
  const agent = createSigner();
  const keys = new StaticPrincipalKeyRegistry([{ kid: agent.kid, publicKeyPem: agent.publicKeyPem, purposes: ["agent"], status: "active" }]);
  const gw = createGateway({ policy, authentication: { keys }, executor: createHttpExecutor({ scheme: "http" }) });
  for (const host of [`127.0.0.1:${port}`, `0x7f000001:${port}`, `[::ffff:7f00:1]:${port}`]) {
    seen.length = 0;
    const r = await gw.handleAction(agent.sign({ action_type: "http.call", params: { host, path: "/a", method: "GET" } }));
    assert.equal(r.allowed, true, host);
    assert.equal(r.receipt.payload.execution.state, "executed", host);
    assert.deepEqual(seen.map((s) => [s.host, s.remote]), [[`127.0.0.1:${port}`, "127.0.0.1"]], host);
  }
  for (const host of [`localhost:${port}`, `[::1]:${port}`, `127.0.0.1`, `127.0.0.2:${port}`]) {
    seen.length = 0;
    const r = await gw.handleAction(agent.sign({ action_type: "http.call", params: { host, path: "/a", method: "GET" } }));
    assert.equal(r.allowed, false, host);
    assert.equal(seen.length, 0, host);
  }
});
