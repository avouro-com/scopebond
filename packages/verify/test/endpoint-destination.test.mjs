// Endpoint clauses compare the destination an HTTP client reaches, not the text of the host: one canonical form for
// every spelling of an address, the port only where an entry names one (denylist), and every loopback destination for
// a listed loopback name or address (denylist). An allowlist entry allows exactly its own host and port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { endpointDestination, endpointDenylistClauses } from "../dist/violates.js";
import { violatesBoth as violates } from "./bounded.mjs";

const AT = "2026-10-09T12:00:00Z";
const policyOf = (...clauses) => ({ vocabulary_version: "1.0", policy_id: "p", version: 1, clauses });
const call = (host, path = "/", method = "GET") => ({ intent: { action_type: "http.call", params: { host, path, method } }, executed: true, timestamp: AT });
const deny = (hosts, extra = {}) => policyOf({ id: "deny", type: "endpoint_denylist", mode: "enforce", hosts, ...extra });
const allow = (hosts) => policyOf({ id: "allow", type: "endpoint_allowlist", mode: "enforce", hosts });

test("endpointDestination gives every spelling of one destination the same form", () => {
  const same = (spellings, expected) => {
    for (const s of spellings) assert.deepEqual(endpointDestination(s), expected, s);
  };
  same(["127.0.0.1", "2130706433", "127.1", "0x7f.1", "0x7f000001", "0177.0.0.1", "127.0.0.1.", "[::ffff:7f00:1]", "[::ffff:127.0.0.1]", "[0:0:0:0:0:ffff:127.0.0.1]"],
    { host: "127.0.0.1", port: null, address: true, loopback: true });
  same(["169.254.169.254:80", "2852039166:80", "0xa9.0xfe.0xa9.0xfe:080", "[::FFFF:A9FE:A9FE]:80"],
    { host: "169.254.169.254", port: 80, address: true, loopback: false });
  same(["[::1]", "[0:0:0:0:0:0:0:1]", "[0::1]"], { host: "[::1]", port: null, address: true, loopback: true });
  same(["[2001:DB8:0:0:0:0:0:1]:8443", "[2001:db8::1]:8443"], { host: "[2001:db8::1]", port: 8443, address: true, loopback: false });
  same(["LOCALHOST", "localhost.", " localhost "], { host: "localhost", port: null, address: false, loopback: true });
  same(["Api.Example.COM.:443", "api.example.com:443"], { host: "api.example.com", port: 443, address: false, loopback: false });
  assert.equal(endpointDestination("a.localhost").loopback, true);
  assert.equal(endpointDestination("0").host, "0.0.0.0");
  assert.equal(endpointDestination("0").loopback, true);
  assert.equal(endpointDestination("[::]").loopback, true);
  assert.equal(endpointDestination("localhost.example").loopback, false);
});

test("endpointDestination refuses what is not a bare host and port", () => {
  for (const bad of [null, 1, "", "x@metadata.internal", "a.example/x", "a.example:99999", "a..example", "localhost..", "[::1", "[fe80::1%25eth0]",
    "256.1.1.1", "1.2.3.4.5", "a.example:80:80", "http://a.example", "a b", "a\\b", "[1:2:3:4:5:6:7:8:9]"]) {
    assert.equal(endpointDestination(bad), null, JSON.stringify(bad));
  }
  const t0 = performance.now();
  assert.equal(endpointDestination("a.".repeat(25_000) + "!"), null);
  assert.ok(endpointDestination("a.".repeat(129) + "a"), "a host at the length cap is read");
  assert.equal(endpointDestination("[" + ":".repeat(50_000)), null);
  assert.ok(performance.now() - t0 < 1000, "linear");
});

test("endpoint_denylist covers other spellings, address families and ports of a listed host", () => {
  const cases = [
    [["127.0.0.1"], ["LOCALHOST:3000", "localhost.:3000", "[::1]:3000", "[::ffff:7f00:1]:3000", "2130706433", "0x7f.1:3000", "127.0.0.2", "0.0.0.0:3000", "[::]"]],
    [["localhost"], ["127.0.0.1:8080", "[::1]", "sub.localhost"]],
    [["169.254.169.254"], ["2852039166", "[::ffff:a9fe:a9fe]", "169.254.169.254:80", "0xa9fea9fe:8080"]],
    [["metadata.internal"], ["METADATA.internal.", "metadata.internal:8080"]],
    [["metadata.internal:80"], ["metadata.internal", "metadata.internal:80"]],
    [["metadata.internal:443"], ["metadata.internal"]],
  ];
  for (const [hosts, requests] of cases) {
    for (const host of requests) {
      const v = violates(deny(hosts), [], call(host));
      assert.equal(v.violated, true, `${JSON.stringify(hosts)} vs ${host}`);
      assert.equal(v.clause_id, "deny");
    }
  }
});

test("endpoint_denylist leaves other destinations alone", () => {
  const cases = [
    [["127.0.0.1"], ["10.0.0.1", "example.com", "[2001:db8::1]"]],
    [["metadata.internal:8080"], ["metadata.internal:9090", "metadata.internal"]],
    [["metadata.internal"], ["metadata.internal.example", "169.254.169.254"]], // a name is compared as a name
    [["10.0.0.5"], ["10.0.0.6", "[::a00:5]"]],
  ];
  for (const [hosts, requests] of cases) {
    for (const host of requests) assert.equal(violates(deny(hosts), [], call(host)).violated, false, `${JSON.stringify(hosts)} vs ${host}`);
  }
  // Paths and methods still narrow a clause.
  const scoped = deny(["127.0.0.1"], { paths: ["/admin/**"], methods: ["POST"] });
  assert.equal(violates(scoped, [], call("[::1]", "/admin/users", "POST")).violated, true);
  assert.equal(violates(scoped, [], call("[::1]", "/public", "POST")).violated, false);
  assert.equal(violates(scoped, [], call("[::1]", "/admin/users", "GET")).violated, false);
  // A host that cannot be compared is denied.
  assert.equal(violates(deny(["127.0.0.1"]), [], call("x@ok.example")).violated, true);
});

test("endpoint_allowlist allows exactly the listed host and port, in any spelling", () => {
  assert.equal(violates(allow(["127.0.0.1:8080"]), [], call("0x7f000001:8080")).violated, false);
  assert.equal(violates(allow(["127.0.0.1:8080"]), [], call("[::ffff:7f00:1]:8080")).violated, false);
  assert.equal(violates(allow(["API.example.com"]), [], call("api.example.com.")).violated, false);
  for (const host of ["[::1]:8080", "localhost:8080", "127.0.0.2:8080", "127.0.0.1", "127.0.0.1:8081"]) {
    assert.equal(violates(allow(["127.0.0.1:8080"]), [], call(host)).violated, true, host);
  }
  assert.equal(violates(allow(["api.example.com"]), [], call("api.example.com:443")).violated, true, "an entry without a port allows the default port only");
});

test("endpointDenylistClauses names the denylist clauses that deny a call, monitor ones included", () => {
  const policy = policyOf(
    { id: "a", type: "endpoint_denylist", mode: "enforce", hosts: ["169.254.169.254"] },
    { id: "b", type: "endpoint_denylist", mode: "monitor", hosts: ["localhost"] },
    { id: "c", type: "endpoint_allowlist", mode: "enforce", hosts: ["ok.example"] },
  );
  assert.deepEqual(endpointDenylistClauses(policy, { host: "[::ffff:a9fe:a9fe]:80", path: "/" }).map((c) => c.id), ["a"]);
  assert.deepEqual(endpointDenylistClauses(policy, { host: "127.0.0.1" }).map((c) => c.id), ["b"]);
  assert.deepEqual(endpointDenylistClauses(policy, { host: "ok.example" }).map((c) => c.id), []);
  assert.deepEqual(endpointDenylistClauses(policy, {}).map((c) => c.id), []);
});
