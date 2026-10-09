// A real `scopebond-gateway` process started the way `init` prints it. It listens on loopback unless told otherwise,
// says where it listens, keeps reloading a policy file that is replaced by rename (an editor save, config management,
// a Kubernetes ConfigMap update), and applies a revoked key without a restart. Every request goes to 127.0.0.1.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { canonical, sha256 } from "../dist/index.js";
import { createSigner } from "@scopebond/sdk";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const running = new Set();
after(async () => { for (const c of running) await stop(c); });

async function stop(child) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  }
  running.delete(child);
}

async function start(dir, env) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [cli, "scopebond.policy.json"], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), SCOPEBOND_ANCHOR_INTERVAL: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.add(child);
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 100 && !/listening/.test(log); i++) await sleep(100);
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${port}/healthz`); break; } catch { await sleep(100); }
  }
  return { child, port, log: () => log };
}

/** Run `body` against a project scaffolded by `init`, then stop the gateway and remove the project. */
async function withProject(body) {
  const dir = mkdtempSync(join(tmpdir(), "sb-cli-serve-"));
  const children = [];
  try {
    const init = execFileSync(process.execPath, [cli, "init"], { cwd: dir, encoding: "utf8" });
    const token = init.match(/SCOPEBOND_CONTROL_TOKEN=(\S+)/)[1];
    const env = { SCOPEBOND_PRINCIPAL_KEYS_FILE: "principal-keys.json", SCOPEBOND_CONTROL_TOKEN: token };
    await body({ dir, token, env, start: async (extra = {}) => { const s = await start(dir, { ...env, ...extra }); children.push(s.child); return s; } });
  } finally {
    for (const c of children) await stop(c);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

/** Replace a file the way editors and config tools do: write a sibling, then rename it over the original. */
function replaceByRename(path, text) {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

const reachable = (host, port) => new Promise((resolve) => {
  const socket = connect({ host, port });
  socket.setTimeout(1500);
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
  socket.once("timeout", () => { socket.destroy(); resolve(false); });
});

async function policyHash(port, token) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/status`, { headers: { authorization: `Bearer ${token}` } });
  return (await res.json()).policy_hash;
}
async function waitFor(check, ms = 10_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await check()) return true; await sleep(100); }
  return false;
}

test("the gateway listens on loopback by default and prints the address it is bound to", () => withProject(async ({ start }) => {
  const { port, log } = await start();
  assert.ok(log().includes(`listening on http://127.0.0.1:${port}`), log());
  assert.equal(await reachable("127.0.0.1", port), true);
  const external = Object.values(networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal);
  if (external) assert.equal(await reachable(external.address, port), false, `not reachable on ${external.address}`);
}));

test("HOST chooses the listen address", () => withProject(async ({ start }) => {
  const { port, log } = await start({ HOST: "0.0.0.0" });
  assert.ok(log().includes(`listening on http://0.0.0.0:${port}`), log());
  assert.equal(await reachable("127.0.0.1", port), true);
}));

test("a policy file replaced by rename is reloaded every time, not only the first", () => withProject(async ({ dir, token, start }) => {
  // Periodic re-reading is switched off: the watcher alone must follow the replacements.
  const { port } = await start({ SCOPEBOND_POLICY_POLL: "0" });
  const path = join(dir, "scopebond.policy.json");
  const base = JSON.parse(readFileSync(path, "utf8"));
  for (const version of [2, 3, 4]) {
    const next = { ...base, version };
    replaceByRename(path, JSON.stringify(next, null, 2) + "\n");
    const want = sha256(canonical(next));
    assert.equal(await waitFor(async () => (await policyHash(port, token)) === want), true, `version ${version} was applied`);
  }
}));

test("a change the watcher missed is still picked up by the periodic check", () => withProject(async ({ dir, token, start }) => {
  const { port } = await start({ SCOPEBOND_POLICY_WATCH: "poll", SCOPEBOND_POLICY_POLL: "200ms" });
  const path = join(dir, "scopebond.policy.json");
  const next = { ...JSON.parse(readFileSync(path, "utf8")), version: 7 };
  replaceByRename(path, JSON.stringify(next));
  assert.equal(await waitFor(async () => (await policyHash(port, token)) === sha256(canonical(next))), true);
}));

test("a key marked revoked in the key registry is refused without a restart; a broken registry keeps the last good one", () => withProject(async ({ dir, start }) => {
  const { port } = await start();
  const agent = createSigner({ privateKeyPem: readFileSync(join(dir, "scopebond-agent.key"), "utf8") });
  const submit = async () => (await fetch(`http://127.0.0.1:${port}/v1/evaluate`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(agent.sign({ action_type: "payout.create", asset: "USDC", amount: 100 })),
  })).status;
  assert.equal(await submit(), 200);
  const registryPath = join(dir, "principal-keys.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  replaceByRename(registryPath, "[not json");
  await sleep(1000);
  assert.equal(await submit(), 200, "an unreadable registry keeps the last good key set");
  replaceByRename(registryPath, JSON.stringify(registry.map((r) => ({ ...r, status: "revoked" }))));
  assert.equal(await waitFor(async () => (await submit()) === 401), true, "the revoked key is refused");
}));
