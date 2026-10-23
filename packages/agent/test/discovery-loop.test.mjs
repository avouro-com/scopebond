import test from "node:test";
import assert from "node:assert/strict";
import { startDiscoveryLoop, DISCOVERY_FALLBACK_MS, DISCOVERY_MAX_WATCHERS } from "../dist/discovery-loop.js";

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("a paused fallback timer reconciles within fifteen seconds of the event loop resuming", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let scans = 0;
  const loop = startDiscoveryLoop({ reconcile: async () => { scans++; }, directories: () => [] });
  t.after(loop.stop);
  t.mock.timers.tick(1); await settle();
  assert.equal(scans, 1);
  // A platform may pause its timer clock during sleep. Resume just after startup with no watcher hints;
  // the worst-case remaining interval must still fit the resume budget, without relying on a wall-clock jump.
  t.mock.timers.tick(14_000); await settle();
  t.mock.timers.tick(1); await settle();
  assert.equal(scans, 2);
});

test("startup, parent directory hints and missed events reconcile without a delivery cycle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const callbacks = new Map();
  let scans = 0;
  let directories = ["profile"];
  const loop = startDiscoveryLoop({ reconcile: async () => { scans++; }, directories: () => directories,
    watchDirectory: (path, changed) => { callbacks.set(path, changed); return { close: () => callbacks.delete(path) }; } });
  t.after(loop.stop);
  t.mock.timers.tick(1); await settle();
  assert.equal(scans, 1);
  directories = ["profile", "profile/new-tool"];
  for (let i = 0; i < 1000; i++) callbacks.get("profile")();
  t.mock.timers.tick(1000); await settle();
  assert.equal(scans, 2);
  assert.ok(callbacks.has("profile/new-tool"));
  t.mock.timers.tick(DISCOVERY_FALLBACK_MS); await settle();
  t.mock.timers.tick(1); await settle();
  assert.equal(scans, 3);
  loop.stop();
  assert.equal(callbacks.size, 0);
  t.mock.timers.tick(DISCOVERY_FALLBACK_MS * 2); await settle();
  assert.equal(scans, 3);
});

test("watch failures use fallback, watcher count is capped, and scans never overlap", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let calls = 0, watched = 0, errors = 0, release;
  const loop = startDiscoveryLoop({ directories: () => Array.from({ length: 100 }, (_, i) => `directory-${i}`),
    watchDirectory: () => { watched++; throw new Error("watch unavailable"); }, onError: () => errors++,
    reconcile: () => { calls++; return new Promise((resolve) => { release = resolve; }); } });
  t.after(loop.stop);
  t.mock.timers.tick(1); await settle();
  assert.equal(watched, DISCOVERY_MAX_WATCHERS);
  assert.equal(errors, DISCOVERY_MAX_WATCHERS);
  for (let i = 0; i < 500; i++) loop.rescan();
  t.mock.timers.tick(DISCOVERY_FALLBACK_MS * 5); await settle();
  assert.equal(calls, 1);
  release(); await settle();
  t.mock.timers.tick(1000); await settle();
  assert.equal(calls, 2);
  loop.stop(); release(); await settle();
});
