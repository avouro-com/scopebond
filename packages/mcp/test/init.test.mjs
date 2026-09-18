import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { starterMcpPolicy } from "../dist/index.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("starterMcpPolicy allows non-destructive tools and denies destructive ones by name", () => {
  const p = starterMcpPolicy("filesystem");
  const bound = p.clauses[0].param_bounds;
  assert.deepEqual(bound.server.enum, ["filesystem"]);
  assert.ok(new RegExp(bound.tool.pattern).test("read_file"));
  assert.equal(new RegExp(bound.tool.pattern).test("delete_file"), false);
});

test("scopebond-mcp init scaffolds a key and a starter policy", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-mcp-init-"));
  const out = execFileSync(process.execPath, [cli, "init", "--server", "filesystem"], { cwd: dir, encoding: "utf8" });
  assert.ok(existsSync(join(dir, "scopebond-agent.key")), "key created");
  assert.ok(existsSync(join(dir, "scopebond.policy.json")), "policy created");
  const policy = JSON.parse(readFileSync(join(dir, "scopebond.policy.json"), "utf8"));
  assert.equal(policy.clauses[0].action_types[0], "mcp.tool.call");
  assert.match(out, /enrolled for server "filesystem"/);
});
