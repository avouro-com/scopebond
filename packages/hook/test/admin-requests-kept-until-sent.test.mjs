// "Ask an admin" requests wait in requests.json until the Scopebond Agent sends them. The file is bounded by dropping old
// SENT requests only: a request nobody has sent yet is never dropped to make room for a newer one.
// Isolated: HOME/USERPROFILE/APPDATA/LOCALAPPDATA/SCOPEBOND_HOME point at a fresh temp folder before any import.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "sb-admin-requests-"));
const fakeHome = join(root, "home");
mkdirSync(fakeHome, { recursive: true });
for (const k of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) process.env[k] = fakeHome;
process.env.SCOPEBOND_HOME = join(fakeHome, ".scopebond");
delete process.env.SCOPEBOND_HOOK_DIR;

const { queueRequest, readRequests, writeRequests } = await import("../dist/requests.js");

const ask = (dir, i, now) => queueRequest(dir, { rule: "R-net", action_key: `key-${i}`, action_id: `act-${i}`, summary: `action ${i}`, reason: "needed for the release", os_user_digest: null, harness: "claude", now });

test("more than 200 unsent requests: the oldest unsent one is still queued", () => {
  assert.equal(homedir(), fakeHome, "isolation: homedir() is the temp folder");
  const dir = join(root, "unsent");
  mkdirSync(dir, { recursive: true });
  const t0 = Date.parse("2026-10-08T09:00:00Z");
  const first = ask(dir, 0, t0);
  for (let i = 1; i <= 200; i++) ask(dir, i, t0 + i * 1000);
  const items = readRequests(dir);
  assert.equal(items.filter((r) => r.sent_at === null).length, 201, "every unsent request is kept");
  assert.ok(items.some((r) => r.id === first.id), "the first request was not dropped before it was sent");
});

test("sent requests are what the cap trims: the newest 200 sent ones stay, every unsent one stays, in order", () => {
  const dir = join(root, "mixed");
  mkdirSync(dir, { recursive: true });
  const now = Date.parse("2026-10-08T09:00:00Z");
  const at = (i) => new Date(now - 60_000 + i).toISOString();
  const items = [];
  for (let i = 0; i < 250; i++) items.push({ id: `sent-${i}`, rule: "R", action_key: `s${i}`, action_id: `s${i}`, summary: "s", reason: "r", os_user_digest: null, harness: "claude", created_at: at(i), sent_at: at(i) });
  for (let i = 0; i < 5; i++) items.splice(i * 40, 0, { id: `unsent-${i}`, rule: "R", action_key: `u${i}`, action_id: `u${i}`, summary: "u", reason: "r", os_user_digest: null, harness: "claude", created_at: at(i), sent_at: null });
  writeRequests(dir, items, now);
  const kept = readRequests(dir);
  assert.deepEqual(kept.filter((r) => !r.sent_at).map((r) => r.id), ["unsent-0", "unsent-1", "unsent-2", "unsent-3", "unsent-4"]);
  const sent = kept.filter((r) => r.sent_at).map((r) => r.id);
  assert.equal(sent.length, 200);
  assert.equal(sent[0], "sent-50", "the oldest sent ones went");
  assert.equal(sent.at(-1), "sent-249");
  assert.deepEqual(kept.map((r) => r.id), items.map((r) => r.id).filter((id) => kept.some((k) => k.id === id)), "the file keeps its order");
});

test("a sent request older than a week still goes", () => {
  const dir = join(root, "week");
  mkdirSync(dir, { recursive: true });
  const now = Date.parse("2026-10-08T09:00:00Z");
  const old = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();
  writeRequests(dir, [
    { id: "old-sent", rule: "R", action_key: "a", action_id: "a", summary: "s", reason: "r", os_user_digest: null, harness: "claude", created_at: old, sent_at: old },
    { id: "old-unsent", rule: "R", action_key: "b", action_id: "b", summary: "s", reason: "r", os_user_digest: null, harness: "claude", created_at: old, sent_at: null },
  ], now);
  assert.deepEqual(readRequests(dir).map((r) => r.id), ["old-unsent"]);
});
