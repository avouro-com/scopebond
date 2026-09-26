// The local receipt store lives in the user's project directory and grows on every tool
// call, so its footprint is a product concern. Two properties are pinned here: a
// short-lived writer leaves no write-ahead log behind, and pruning can never silently
// invalidate evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, statSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openReceiptStore } from "@scopebond/gateway/node";
import { DatabaseSync } from "node:sqlite";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function project(name) {
  const dir = mkdtempSync(join(tmpdir(), `sb-store-${name}-`));
  const config = join(dir, ".scopebond");
  execFileSync(process.execPath, [cli, "init", "--no-install", "--yes"], {
    cwd: dir, encoding: "utf8", env: { ...process.env, SCOPEBOND_HOOK_DIR: config },
  });
  return { dir, config };
}

function toolCall(config, cwd, command) {
  const payload = JSON.stringify({ cwd, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
  try {
    execFileSync(process.execPath, [cli, "claude"], {
      cwd, input: payload, encoding: "utf8", env: { ...process.env, SCOPEBOND_HOOK_DIR: config },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch { /* a deny exits 2; the receipt is still written */ }
}

const sizeOf = (file) => (existsSync(file) ? statSync(file).size : 0);

test("a per-tool-call writer leaves no write-ahead log behind", () => {
  const { dir, config } = project("wal");
  const db = join(config, "receipts.db");
  for (let i = 0; i < 12; i += 1) toolCall(config, dir, "npm test");
  // The measured bug: each process exited without closing, so its WAL frames stayed on
  // disk and the next process appended to the same file — about 11 KiB per receipt of
  // pure overhead, versus ~1.7 KiB once the handle is closed.
  assert.equal(sizeOf(`${db}-wal`), 0, "no write-ahead log is left on disk");
  assert.equal(sizeOf(`${db}-shm`), 0, "no shared-memory file is left either");
  const perReceipt = sizeOf(db) / 12;
  assert.ok(perReceipt < 40_000, `store stays proportionate: ${Math.round(perReceipt)} bytes/receipt`);
});

test("log reads a tail, filters by decision, and filters by age", () => {
  const { dir, config } = project("log");
  toolCall(config, dir, "npm test");   // allow
  toolCall(config, dir, "rm -rf src"); // deny
  toolCall(config, dir, "npm run build"); // allow
  const run = (args) => execFileSync(process.execPath, [cli, ...args], {
    cwd: dir, encoding: "utf8", env: { ...process.env, SCOPEBOND_HOOK_DIR: config },
  });
  const all = run(["log"]);
  assert.match(all, /shell\.exec npm/);
  assert.match(all, /shell\.exec rm/);

  const denied = run(["log", "--deny"]);
  assert.match(denied, /shell\.exec rm/);
  assert.doesNotMatch(denied, /shell\.exec npm/, "--deny shows only blocked actions");
  assert.match(denied, /matching denied/);

  const recent = run(["log", "--since", "1h"]);
  assert.match(recent, /shell\.exec/, "everything just happened, so it is all within the hour");
  const ancient = run(["log", "--since", "2026-01-01"]);
  assert.match(ancient, /shell\.exec/, "an absolute date is accepted");
  // A bad --since is refused rather than silently ignored.
  assert.throws(() => run(["log", "--since", "soonish"]), /wants a duration/);
});

test("status reports the store's size and count, so growth is never a surprise", () => {
  const { dir, config } = project("status");
  for (let i = 0; i < 3; i += 1) toolCall(config, dir, "npm test");
  const out = execFileSync(process.execPath, [cli, "status"], {
    cwd: dir, encoding: "utf8", env: { ...process.env, SCOPEBOND_HOOK_DIR: config },
  });
  assert.match(out, /local receipts.*3 receipt\(s\), \d+ (KiB|MiB)/);
});

test("prune reports the footprint and removes nothing without a cutoff", () => {
  const { dir, config } = project("prune-report");
  toolCall(config, dir, "npm test");
  const db = join(config, "receipts.db");
  const before = sizeOf(db);
  const out = execFileSync(process.execPath, [cli, "prune"], {
    cwd: dir, encoding: "utf8", env: { ...process.env, SCOPEBOND_HOOK_DIR: config },
  });
  assert.match(out, /Nothing is removed automatically/);
  assert.match(out, /1 receipt\(s\)/);
  assert.equal(sizeOf(db), before, "reporting does not change the store");
});

test("prune archives before it removes, and keeps newer receipts", () => {
  const { dir, config } = project("prune-do");
  toolCall(config, dir, "npm test");
  // Backdate the stored receipt so a cutoff can select it.
  const { store } = openReceiptStore({ db: join(config, "receipts.db") });
  store.close?.();
  const db = join(config, "receipts.db");
  const handle = new DatabaseSync(db);
  handle.prepare("UPDATE receipts SET timestamp = ?").run("2020-01-01T00:00:00.000Z");
  handle.close();
  toolCall(config, dir, "npm run build"); // a receipt with today's timestamp

  const out = execFileSync(process.execPath, [cli, "prune", "--before", "2021-01-01", "--yes"], {
    cwd: dir, encoding: "utf8", env: { ...process.env, SCOPEBOND_HOOK_DIR: config },
  });
  assert.match(out, /archived to/);
  assert.match(out, /removed\s+1 receipt/);
  const archives = readdirSync(config).filter((f) => f.startsWith("receipts-archived-"));
  assert.equal(archives.length, 1, "exactly one archive was written");
  const archived = readFileSync(join(config, archives[0]), "utf8").trim().split("\n");
  assert.equal(archived.length, 1);
  // The archive is still a signed receipt, not a summary. Note the signed payload is
  // untouched — the backdating above changed only the index column prune selects on,
  // because the payload is covered by the signature and must never be rewritten.
  const receipt = JSON.parse(archived[0]);
  assert.ok(receipt.signature, "the archived receipt keeps its signature");
  assert.equal(receipt.payload.intent.params.program, "npm", "it is the receipt that was removed");
  assert.ok(receipt.payload.attester?.kid, "and it still names its attester, so it can be verified");

  const after = openReceiptStore({ db });
  const remaining = after.store.list();
  after.store.close?.();
  assert.equal(remaining.length, 1, "the newer receipt is untouched");
});

test("prune refuses once the log is anchored, rather than invalidating the anchor", () => {
  const { dir, config } = project("prune-anchored");
  toolCall(config, dir, "npm test");
  const db = join(config, "receipts.db");
  const handle = new DatabaseSync(db);
  handle.prepare("UPDATE receipts SET timestamp = ?").run("2020-01-01T00:00:00.000Z");
  // An anchor pins receipt positions as Merkle leaf indices, so removing one breaks it.
  handle.prepare("INSERT INTO anchors (seq, anchor_json) VALUES (?, ?)").run(1, JSON.stringify({ seq: 1, root: "abc" }));
  handle.close();

  let status = 0;
  let stderr = "";
  try {
    execFileSync(process.execPath, [cli, "prune", "--before", "2021-01-01", "--yes"], {
      cwd: dir, encoding: "utf8", env: { ...process.env, SCOPEBOND_HOOK_DIR: config }, stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) { status = error.status; stderr = String(error.stderr ?? ""); }
  assert.equal(status, 1, "pruning an anchored log fails");
  assert.match(stderr, /anchor/i, "and says why");
  const after = openReceiptStore({ db });
  assert.equal(after.store.list().length, 1, "nothing was removed");
  after.store.close?.();
});

test("prune needs an explicit confirmation when there is no terminal", () => {
  const { dir, config } = project("prune-confirm");
  toolCall(config, dir, "npm test");
  const handle = new DatabaseSync(join(config, "receipts.db"));
  handle.prepare("UPDATE receipts SET timestamp = ?").run("2020-01-01T00:00:00.000Z");
  handle.close();
  let status = 0;
  let stderr = "";
  try {
    execFileSync(process.execPath, [cli, "prune", "--before", "2021-01-01"], {
      cwd: dir, encoding: "utf8", env: { ...process.env, SCOPEBOND_HOOK_DIR: config }, input: "", stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) { status = error.status; stderr = String(error.stderr ?? ""); }
  assert.equal(status, 1);
  assert.match(stderr, /--yes/);
  const after = openReceiptStore({ db: join(config, "receipts.db") });
  assert.equal(after.store.list().length, 1, "nothing removed without confirmation");
  after.store.close?.();
});

test("uninstall removes the project hook, not only the user-level one", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-uninstall-"));
  const config = join(dir, ".scopebond");
  const home = join(dir, "home");
  const env = { ...process.env, SCOPEBOND_HOOK_DIR: config, SCOPEBOND_HOME: home, HOME: home, USERPROFILE: home };
  execFileSync(process.execPath, [cli, "init", "--yes"], { cwd: dir, encoding: "utf8", env });
  const settings = join(dir, ".claude", "settings.json");
  assert.ok(readFileSync(settings, "utf8").includes("scopebond"), "precondition: the project hook is installed");
  const out = execFileSync(process.execPath, [cli, "uninstall", "--yes"], { cwd: dir, encoding: "utf8", env });
  assert.match(out, /removed the Scopebond hook from/);
  assert.ok(!readFileSync(settings, "utf8").includes("scopebond"), "the project hook is gone");
});

test("init backs up an existing agent config before changing it", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-backup-"));
  const config = join(dir, ".scopebond");
  const settings = join(dir, ".claude", "settings.json");
  execFileSync(process.execPath, ["-e", `require("fs").mkdirSync(${JSON.stringify(join(dir, ".claude"))},{recursive:true})`]);
  const original = JSON.stringify({ theme: "light", permissions: { allow: ["Bash(npm test)"] } }, null, 2);
  writeFileSync(settings, original);
  execFileSync(process.execPath, [cli, "init", "--yes"], {
    cwd: dir, encoding: "utf8", env: { ...process.env, SCOPEBOND_HOOK_DIR: config },
  });
  const backup = `${settings}.scopebond-backup`;
  assert.ok(existsSync(backup), "the original was copied aside");
  assert.equal(readFileSync(backup, "utf8"), original, "the backup is the untouched original");
  const merged = JSON.parse(readFileSync(settings, "utf8"));
  assert.equal(merged.theme, "light", "and the user's own settings survived the merge");
  assert.deepEqual(merged.permissions.allow, ["Bash(npm test)"]);
});
