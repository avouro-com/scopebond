// The upstream server named by a bare program name ("node") is found in the absolute folders on its PATH, never in the
// current folder: on Windows a spawn by bare name looks there first (unless NoDefaultCurrentDirectoryInExePath is set,
// which Windows does not set by default), and the proxy runs in the project, which anyone can put a node.exe in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";

const windows = process.platform === "win32";
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const UPSTREAM = `
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && m.id !== null) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { upstream: m.method } }) + "\\n");
});
`;
const policy = {
  vocabulary_version: "1.0", policy_id: "mcp-path", version: 1,
  clauses: [{ id: "fs", type: "action_allowlist", mode: "enforce", action_types: ["mcp.tool.call"], param_bounds: { server: { enum: ["filesystem"] } } }],
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "sb-mcp-path-"));
  writeFileSync(join(dir, "upstream.mjs"), UPSTREAM);
  writeFileSync(join(dir, "policy.json"), JSON.stringify(policy));
  writeFileSync(join(dir, "key.pem"), generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (k.toLowerCase() !== "nodefaultcurrentdirectoryinexepath" && k.toUpperCase() !== "NODE_OPTIONS") env[k] = v;
  return { dir, env, args: ["--server", "filesystem", "--policy", join(dir, "policy.json"), "--key", join(dir, "key.pem"), "--receipts", join(dir, "receipts.jsonl")] };
}

test("an upstream named by a bare name that is on no PATH folder is not started, and the proxy says so", () => {
  const s = setup();
  try {
    const r = spawnSync(process.execPath, [cli, ...s.args, "--", "sb-no-such-upstream", "x"], { cwd: s.dir, env: s.env, encoding: "utf8", input: "" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /could not start the upstream server: sb-no-such-upstream was not found in a folder on PATH/);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("Windows: an upstream named `node` is the node on PATH, never a node.exe in the project folder", { skip: !windows && "Windows-only program search" }, async () => {
  const s = setup();
  const project = mkdtempSync(join(tmpdir(), "sb-mcp-hostile-"));
  try {
    copyFileSync(process.execPath, join(project, "node.exe"));
    const preload = join(s.dir, "preload.cjs");
    // The planted copy is also called node.exe: it is told apart by the folder it started from.
    writeFileSync(preload, `const { dirname, join } = require("node:path");
if (dirname(process.execPath).toLowerCase() === ${JSON.stringify(project.toLowerCase())}) require("node:fs").writeFileSync(join(${JSON.stringify(s.dir)}, "planted.ran"), "");`);
    const proc = spawn(process.execPath, [cli, ...s.args, "--env", "NODE_OPTIONS", "--", "node", join(s.dir, "upstream.mjs")], {
      cwd: project, env: { ...s.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d; });
    const reply = new Promise((resolve) => createInterface({ input: proc.stdout }).on("line", (line) => resolve(JSON.parse(line))));
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) + "\n");
    const answer = await Promise.race([reply, once(proc, "exit").then(() => ({ exited: stderr }))]);
    proc.kill();
    await once(proc, "exit").catch(() => {});
    assert.deepEqual(answer.result, { upstream: "tools/list" }, `the upstream answered: ${JSON.stringify(answer)}`);
    assert.deepEqual(readdirSync(s.dir).filter((f) => f.endsWith(".ran")), [], "the node.exe in the project folder did not run");
  } finally {
    for (const d of [s.dir, project]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* a planted copy still closing */ } }
  }
});
