// The agent's local channel serves only local programs: on loopback a request must name 127.0.0.1 (or localhost) at the
// agent's own port as its Host, and no request may carry an Origin (a web page's request does; the CLI, the hook and the
// trays never send one). This holds even with the token, so a page that rebinds a name to 127.0.0.1 is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestOverSocket } from "@scopebond/hook";
import { startControl, callAgent, readEndpoint, TOKEN_HEADER } from "../dist/index.js";

/** A raw request, so the Host header is exactly what the test says (fetch sets its own). */
function raw(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers, setHost: false }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
    req.end();
  });
}

test("loopback: a foreign Host or any Origin is refused, even with the token; the agent's own callers still work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-ipc-host-"));
  const control = await startControl(dir, "agent/test", { "GET /status": () => ({ ok: true }), "POST /flush": () => ({ flushed: true }) }, { loopback: true });
  try {
    const { port, token, socket } = readEndpoint(dir);
    assert.ok(port > 0);
    const auth = { [TOKEN_HEADER]: token };
    assert.equal(await raw(port, "/status", { ...auth, host: `127.0.0.1:${port}` }), 200, "the agent's own address");
    assert.equal(await raw(port, "/status", { ...auth, host: `localhost:${port}` }), 200, "localhost at the same port");
    assert.equal(await raw(port, "/status", { ...auth, host: "attacker.example:1234" }), 403, "a rebinding page's Host");
    assert.equal(await raw(port, "/status", { ...auth, host: `attacker.example:${port}` }), 403);
    assert.equal(await raw(port, "/status", { ...auth, host: `127.0.0.1:${port + 1 === 65536 ? 1 : port + 1}` }), 403, "another port");
    assert.ok([400, 403].includes(await raw(port, "/status", { ...auth })), "no Host at all (Node's server refuses it first, 400)");
    assert.equal(await raw(port, "/status", { ...auth, host: `127.0.0.1:${port}`, origin: "http://attacker.example" }), 403, "a web page's Origin");
    assert.equal(await raw(port, "/status", { ...auth, host: `127.0.0.1:${port}`, origin: "null" }), 403, "an opaque Origin");
    const viaFetch = await fetch(`http://127.0.0.1:${port}/status`, { headers: { ...auth, origin: "http://attacker.example" } });
    assert.equal(viaFetch.status, 403);
    assert.equal(viaFetch.headers.get("access-control-allow-origin"), null);
    // The CLI's own client (fetch over loopback, and the pipe or socket) is unaffected.
    assert.deepEqual(await callAgent(dir, "POST", "/flush", {}), { flushed: true });
    const res = await fetch(`http://127.0.0.1:${port}/status`, { headers: auth });
    assert.equal(res.status, 200);
    if (socket) {
      const local = await requestOverSocket(socket, "GET", "/status", auth, undefined, 2_000);
      assert.equal(local.status, 200, "the pipe or socket, with the token");
      const page = await requestOverSocket(socket, "GET", "/status", { ...auth, origin: "http://attacker.example" }, undefined, 2_000);
      assert.equal(page.status, 403, "an Origin is refused on the pipe or socket too");
    }
  } finally { await control.close(); }
});
