// A fail-closed deny names the broken file and the command that fixes it. "Repair: run init" did nothing for a file that exists
// (init writes only what is missing), so a corrupt rules file blocked every action with no working fix. `doctor` reports a rules
// file that does not parse and a workspace it cannot reach, instead of "All good.".
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scaffold } from "../dist/index.js";
import { repairFor } from "../dist/cli-main.js";
import { ENFORCE } from "./enforce-all.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function runHook(dir, args, input) {
  try {
    return { status: 0, stdout: execFileSync(process.execPath, [cli, ...args], { input, encoding: "utf8", env: { ...process.env, SCOPEBOND_HOOK_DIR: dir } }) };
  } catch (error) {
    return { status: error.status, stdout: String(error.stdout ?? "") };
  }
}

test("a rules file that does not parse: the deny names the file and the real fix, not init", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-hook-repair-"));
  scaffold(dir, ENFORCE);
  writeFileSync(join(dir, "policy.json"), "{ not json");
  const r = runHook(dir, ["claude"], JSON.stringify({ tool_name: "Write", tool_input: { file_path: "src/app.ts" } }));
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stdout, /failed closed: the rules file .*policy\.json is not valid JSON/);
  assert.match(r.stdout, /rules apply/);
  assert.match(r.stdout, /init --force.*replaces your own rules/);
  assert.doesNotMatch(r.stdout, /Repair: run `[^`]*init`\./);
});

test("each kind of setup failure gets its own repair", () => {
  assert.match(repairFor(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" })), /free some disk space/);
  assert.match(repairFor(Object.assign(new Error("EACCES"), { code: "EACCES", path: "/srv/sb/receipts.db" })), /can read and write \/srv\/sb\/receipts\.db/);
  assert.match(repairFor(Object.assign(new Error("ENOENT"), { code: "ENOENT", path: "/x/agent.key" })), /\/x\/agent\.key is missing: run `.*init`/);
  assert.equal(repairFor(Object.assign(new Error("x"), { repair: "do this" })), "do this");
  assert.match(repairFor(new Error("something else")), /doctor`, which names what is broken/);
  assert.match(repairFor(new Error("SQLITE_BUSY: database is locked")), /run the action again/);
  // A missing rules file on a computer with its own rules: init creates it (rules apply would need agent.key and rules.json).
  assert.match(repairFor(Object.assign(new Error("ENOENT"), { code: "ENOENT", file: "/x/policy.json", kind: "policy", managed: false })), /\/x\/policy\.json is missing: run `.*init`/);
  // A computer that follows its workspace's rules refuses `rules apply`: fetch them again instead, never `init --force`.
  for (const code of [undefined, "ENOENT"]) {
    const repair = repairFor(Object.assign(new SyntaxError("not valid JSON"), { code, file: "/x/policy.json", kind: "policy", managed: true }));
    assert.match(repair, /policy sync/);
    assert.doesNotMatch(repair, /rules apply|init --force/);
  }
});

test("a workspace-managed computer whose rules file does not parse is told to fetch the rules again", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-hook-repair-managed-"));
  scaffold(dir, ENFORCE);
  writeFileSync(join(dir, "managed-rules.json"), JSON.stringify({ revision: 1, local_changes: false }));
  writeFileSync(join(dir, "policy.json"), "{ not json");
  const r = runHook(dir, ["claude"], JSON.stringify({ tool_name: "Write", tool_input: { file_path: "src/app.ts" } }));
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stdout, /policy sync/);
  assert.doesNotMatch(r.stdout, /rules apply/);
});

test("doctor counts a broken rules file and an unreachable workspace as problems", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-hook-doctor-"));
  scaffold(dir, ENFORCE);
  writeFileSync(join(dir, "policy.json"), "{ not json");
  // A workspace that never answers: doctor gives up after its timeout instead of hanging, and does not say All good.
  const server = createServer(() => { /* never answers */ });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(dir, "connection.json"), JSON.stringify({ url, credential: "sbm_us_0_test", organization_id: "o", environment_id: "e" }));
  try {
    const r = await new Promise((resolve) => {
      import("node:child_process").then(({ execFile }) => {
        execFile(process.execPath, [cli, "doctor"], { encoding: "utf8", env: { ...process.env, SCOPEBOND_HOOK_DIR: dir }, timeout: 60_000 }, (error, stdout) => resolve({ code: error?.code ?? 0, stdout }));
      });
    });
    assert.notEqual(r.code, 0, r.stdout);
    assert.doesNotMatch(r.stdout, /All good\./);
    assert.match(r.stdout, /policy\.json is not valid JSON.*rules apply/);
  } finally { server.closeAllConnections?.(); server.close(); }
});
