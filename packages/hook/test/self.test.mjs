// How the hook finds itself, in the npm build (the single executable is tested where it is built).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { hookCliPath, hookSelfCommand, isSingleExecutable, nodeSqlite } from "../dist/index.js";

test("from npm, the hook starts itself as Node with its own cli.js, and loads SQLite from Node's built-ins", () => {
  assert.equal(isSingleExecutable(), false);
  assert.ok(existsSync(hookCliPath()), hookCliPath());
  assert.match(hookCliPath(), /[\\/]dist[\\/]cli\.js$/);
  const [program, args] = hookSelfCommand(["help"]);
  assert.equal(program, process.execPath);
  assert.deepEqual(args, [hookCliPath(), "help"]);
  const run = spawnSync(program, args, { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /scopebond-hook/);
  const { DatabaseSync } = nodeSqlite();
  const db = new DatabaseSync(":memory:");
  assert.equal(db.prepare("SELECT 1 AS one").get().one, 1);
  db.close();
});

test("the commands load without running: importing cli-main does nothing until main is called", async () => {
  const before = process.exitCode;
  const { main } = await import("../dist/cli-main.js");
  assert.equal(typeof main, "function");
  assert.equal(process.exitCode, before);
});
