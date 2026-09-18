import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const run = (dir, ...args) => execFileSync(process.execPath, [cli, "init", ...args], { cwd: dir, encoding: "utf8", stdio: "pipe" });

test("init scaffolds a coherent, self-consistent project", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-init-"));
  const out = run(dir);

  for (const f of ["scopebond-agent.key", "principal-keys.json", "scopebond.policy.json"]) {
    assert.ok(existsSync(join(dir, f)), `${f} exists`);
  }

  const keys = JSON.parse(readFileSync(join(dir, "principal-keys.json"), "utf8"));
  assert.equal(keys.length, 1);
  assert.deepEqual(keys[0].purposes, ["agent"]);
  assert.equal(keys[0].status, "active");
  assert.match(keys[0].public_key_pem, /BEGIN PUBLIC KEY/);

  const policy = JSON.parse(readFileSync(join(dir, "scopebond.policy.json"), "utf8"));
  const keyClause = policy.clauses.find((c) => c.type === "key_policy");
  assert.ok(keyClause, "policy has a key_policy clause");
  // The scaffolded policy trusts exactly the scaffolded agent key (a resolved kid).
  assert.equal(keyClause.active_keys.length, 1);
  assert.match(keyClause.active_keys[0], /^key:/);
  // The control token is printed for the operator, never written to a file.
  assert.match(out, /SCOPEBOND_CONTROL_TOKEN=/);
});

test("init refuses to overwrite without --force, then overwrites with it", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-init-"));
  run(dir);
  assert.throws(() => run(dir), "second init without --force fails closed");
  assert.match(run(dir, "--force"), /scaffolded/);
});
