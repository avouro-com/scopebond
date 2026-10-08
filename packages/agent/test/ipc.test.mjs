// The agent's local channel over a named pipe (Windows) or a Unix socket, with loopback for one more release.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { askAgent, requestOverSocket } from "@scopebond/hook";
import { startControl, callAgent, readEndpoint, localSocketPath, TOKEN_HEADER } from "../dist/index.js";

test("each start gets its own pipe name, which says nothing about the user", () => {
  const a = localSocketPath("C:\\Users\\a\\.scopebond", "win32"), b = localSocketPath("C:\\Users\\a\\.scopebond", "win32");
  assert.match(a, /^\\\\\.\\pipe\\scopebond-agent-[0-9a-f]{32}$/);
  assert.notEqual(a, b, "a random name: another user cannot guess it or take it first");
  assert.equal(localSocketPath("/opt/sb/.scopebond", "linux"), join("/opt/sb/.scopebond", "run", "agent.sock"));
  const long = localSocketPath(`/opt/${"x".repeat(120)}/.scopebond`, "darwin");
  assert.ok(Buffer.byteLength(long) < Buffer.byteLength(`/opt/${"x".repeat(120)}/.scopebond`), "a path too long for a socket moves to a private folder");
});

test("the agent answers over its pipe or socket, with the token, also with loopback turned off", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-ipc-"));
  const saved = process.env.SCOPEBOND_AGENT_LOOPBACK;
  process.env.SCOPEBOND_AGENT_LOOPBACK = "0";
  const control = await startControl(dir, "agent/test", {
    "GET /status": () => ({ ok: true }),
    "POST /override": (body) => ({ decision: "allow", reason: `asked about ${body.rule}`, lasts: "once" }),
  });
  try {
    const endpoint = readEndpoint(dir);
    assert.equal(endpoint.port, 0, "no loopback port");
    assert.ok(endpoint.socket);
    assert.deepEqual(await callAgent(dir, "GET", "/status"), { ok: true });
    const anonymous = await requestOverSocket(endpoint.socket, "GET", "/status", {}, undefined, 2_000);
    assert.equal(anonymous.status, 401, "the token is still required");
    const wrong = await requestOverSocket(endpoint.socket, "GET", "/status", { [TOKEN_HEADER]: "x".repeat(32) }, undefined, 2_000);
    assert.equal(wrong.status, 401);
    // The hook's override window request reaches the agent the same way.
    const answer = await askAgent(dir, { rule: "safe-shell" }, 5_000);
    assert.deepEqual(answer, { decision: "allow", reason: "asked about safe-shell", lasts: "once" });
    if (process.platform !== "win32") {
      assert.equal(statSync(endpoint.socket).mode & 0o777, 0o600, "the socket is the user's only");
      assert.equal(statSync(dirname(endpoint.socket)).mode & 0o777, 0o700, "and so is its folder");
    }
  } finally {
    await control.close();
    if (saved === undefined) delete process.env.SCOPEBOND_AGENT_LOOPBACK; else process.env.SCOPEBOND_AGENT_LOOPBACK = saved;
  }
  assert.equal(await callAgent(dir, "GET", "/status", undefined, 1_000), null, "nothing answers once it stopped");
});

test("loopback stays on by default for one release, for the tray that still uses it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-ipc-loop-"));
  const control = await startControl(dir, "agent/test", { "GET /status": () => ({ ok: true }) });
  try {
    const endpoint = readEndpoint(dir);
    assert.ok(endpoint.port > 0);
    const res = await fetch(`http://127.0.0.1:${endpoint.port}/status`, { headers: { [TOKEN_HEADER]: endpoint.token } });
    // Windows PowerShell 5.1 (the tray) decodes a body without a charset as Latin-1: "·" would show as "Â·".
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
    assert.deepEqual(await res.json(), { ok: true });
  } finally { await control.close(); }
});
