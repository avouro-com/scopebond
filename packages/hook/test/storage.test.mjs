// A hook call's memory does not grow with the local history, an older store shrinks when it is compacted, and the
// retention the workspace sets is read and bounded (SB401–SB407, D144). The 700 MB proof is the same code with
// `node test/large-store.mjs "" 700`; CI builds a smaller file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { seedProject, buildLegacyStore, hookPeakMb } from "./large-store.mjs";
import { localRetentionDays, retentionDaysFrom, upkeepIfDue } from "../dist/index.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const MB = 1024 * 1024;

test("a hook call's memory does not grow with the local history", () => {
  const small = seedProject();
  const smallPeak = hookPeakMb(small.config, small.dir, "git status");
  const large = seedProject();
  const built = buildLegacyStore(large.config, 60);
  assert.ok(built.bytes > 50 * MB, `fixture is ${Math.round(built.bytes / MB)} MB`);
  const largePeak = hookPeakMb(large.config, large.dir, "cd src && git status && grep x y");
  // Reading the whole log for the replay check cost ~2 MB of memory per 1,000 receipts per command part.
  assert.ok(largePeak - smallPeak < 20, `peak ${largePeak.toFixed(1)} MB with ${built.rows} actions vs ${smallPeak.toFixed(1)} MB with a few`);
});

test("prune --compact rewrites an older store and keeps every receipt", () => {
  const { dir, config } = seedProject();
  const built = buildLegacyStore(config, 30);
  const out = execFileSync(process.execPath, [cli, "prune", "--compact"], {
    cwd: dir, encoding: "utf8", env: { ...process.env, SCOPEBOND_HOOK_DIR: config },
  });
  assert.match(out, /rewrote\s+\d+ older row/);
  const after = statSync(join(config, "receipts.db")).size;
  assert.ok(after < built.bytes * 0.3, `${Math.round(built.bytes / MB)} MB became ${Math.round(after / MB)} MB`);
  const db = new DatabaseSync(join(config, "receipts.db"), { readOnly: true });
  try { assert.equal(Number(Object.values(db.prepare("SELECT COUNT(*) FROM receipts").get())[0]), built.rows); }
  finally { db.close(); }
});

test("a hook-only install leaves an older file to one background compaction, asked at most hourly", () => {
  const { config } = seedProject();
  buildLegacyStore(config, 5);
  const asked = [];
  const now = Date.now();
  const before = statSync(join(config, "receipts.db")).size;
  upkeepIfDue(config, now, (dir) => asked.push(dir));
  assert.deepEqual(asked, [config], "a separate process rewrites the file; the tool call does not");
  upkeepIfDue(config, now + 30 * 60_000, (dir) => asked.push(dir));
  assert.equal(asked.length, 1, "not asked again within the hour");
  upkeepIfDue(config, now + 2 * 60 * 60_000, (dir) => asked.push(dir));
  assert.equal(asked.length, 2, "asked again while the file is still old");
  assert.ok(statSync(join(config, "receipts.db")).size >= before * 0.9, "the call itself rewrote nothing");
});

test("local retention: none without a workspace, 30 days by default, the workspace's choice within 7–365", () => {
  const headers = (value) => ({ get: (name) => (name === "x-scopebond-local-retention-days" ? value : null) });
  assert.equal(retentionDaysFrom(headers("90")), 90);
  assert.equal(retentionDaysFrom(headers("1")), 7);
  assert.equal(retentionDaysFrom(headers("9999")), 365);
  assert.equal(retentionDaysFrom(headers("ninety")), null);
  assert.equal(retentionDaysFrom(headers(null)), null);

  const { config } = seedProject();
  assert.equal(localRetentionDays(config), null, "a computer with no workspace keeps everything");
  writeFileSync(join(config, "cloud.json"), JSON.stringify({ url: "https://workspace.example", credential: "sbm_test" }));
  assert.equal(localRetentionDays(config), 30);
  writeFileSync(join(config, "managed-meta.json"), JSON.stringify({ local_retention_days: 120 }));
  assert.equal(localRetentionDays(config), 120);
  writeFileSync(join(config, "managed-meta.json"), JSON.stringify({ local_retention_days: 2 }));
  assert.equal(localRetentionDays(config), 7);
});
