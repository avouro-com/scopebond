// Fault: an update does not install (its download fails). Scopebond keeps protecting on the version it runs and tries again
// after 1 hour, 6 hours, then every 24 hours; the person hears nothing until three tries failed, and then only a quiet line
// in Settings: "Update didn't install; Scopebond keeps protecting on <version>".
import { MIN, HOUR, agent, computer, modelInput, seen, serve, tray, trayModel, workspace } from "./b2-fault-helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { recordFailedUpdate, recentlyFailedUpdate, failedUpdate, agentVersion, FAILED_UPDATE_FILE } = agent;
const NOW = Date.parse("2026-10-20T15:30:00Z");

test("a failed update is tried again after 1 hour, then 6 hours, then every 24 hours", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-b2-update-"));
  recordFailedUpdate(dir, "0.12.0", NOW, "the installer could not be downloaded");
  assert.equal(recentlyFailedUpdate(dir, "0.12.0", NOW + 59 * MIN), true);
  assert.equal(recentlyFailedUpdate(dir, "0.12.0", NOW + 61 * MIN), false, "tried again after an hour");
  const second = NOW + 61 * MIN;
  recordFailedUpdate(dir, "0.12.0", second, "again");
  assert.equal(recentlyFailedUpdate(dir, "0.12.0", second + 5 * HOUR), true);
  assert.equal(recentlyFailedUpdate(dir, "0.12.0", second + 6 * HOUR + MIN), false, "then after six hours");
  const third = second + 6 * HOUR + MIN;
  recordFailedUpdate(dir, "0.12.0", third, "and again");
  assert.equal(failedUpdate(dir, third + MIN)?.failures, 3);
  assert.equal(recentlyFailedUpdate(dir, "0.12.0", third + 23 * HOUR), true);
  assert.equal(recentlyFailedUpdate(dir, "0.12.0", third + 24 * HOUR + MIN), false, "then every day");
  // Another version starts counting again.
  recordFailedUpdate(dir, "0.12.1", third + HOUR);
  assert.equal(failedUpdate(dir, third + HOUR)?.failures, 1);
});

test("fewer than three failed tries say nothing; from the third, one quiet Settings line and no toast state", () => {
  const model = (failures) => seen(trayModel(modelInput(NOW, {}, {
    version: { agent: "0.11.5", hook: "0.30.0", policy: "recommended", recommendedAgent: "0.12.0", recommendedHook: null, failedUpdate: { version: "0.12.0", reason: "download failed", failures } },
  })));
  for (const n of [1, 2]) {
    const m = model(n);
    assert.equal(m.state, "protected");
    assert.equal(m.row("Version"), "Scopebond 0.11.5", `${n} failed: nothing about it`);
  }
  const third = model(3);
  assert.equal(third.state, "protected");
  assert.equal(third.fix, null);
  assert.equal(third.row("Version"), "Update didn't install; Scopebond keeps protecting on 0.11.5");
});

test("the download fails three times as the clock moves on: the agent tries by itself and keeps protecting", async () => {
  const ws = workspace();
  const { dir } = computer();
  ws.answers["client-version"] = { policy: "recommended", agent: null, hook: null, native_agent: "0.99.0" };
  const service = await serve(dir, ws, { installKind: "per-user", nativeUpdates: true });
  const age = (ms) => {
    const file = join(dir, FAILED_UPDATE_FILE);
    const r = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...r, at: r.at - ms }));
  };
  try {
    await service.maintainNow();
    assert.equal(failedUpdate(dir)?.failures, 1, "the first try failed and was recorded");
    let m = seen(await tray(dir));
    assert.equal(m.state, "protected");
    assert.equal(m.row("Version"), `Scopebond ${agentVersion()}`);
    const tries = ws.calls.download;
    await service.maintainNow();
    assert.equal(ws.calls.download, tries, "not again within the hour");
    age(61 * MIN);
    await service.maintainNow();
    assert.equal(failedUpdate(dir)?.failures, 2);
    age(6 * HOUR + MIN);
    await service.maintainNow();
    assert.equal(failedUpdate(dir)?.failures, 3);
    m = seen(await tray(dir));
    assert.equal(m.state, "protected");
    assert.equal(m.row("Version"), `Update didn't install; Scopebond keeps protecting on ${agentVersion()}`);
  } finally { await service.stop(); }
});

test("on macOS the signed executable never takes the Windows installer's path: a new package updates it", async () => {
  const ws = workspace();
  const { dir } = computer();
  ws.answers["client-version"] = { policy: "recommended", agent: null, hook: null, native_agent: "0.99.0" };
  const lines = [];
  const service = await serve(dir, ws, { installKind: "per-user", nativeUpdates: false, log: (line) => lines.push(line) });
  try {
    await service.maintainNow();
    assert.equal(ws.calls.download ?? 0, 0, "no installer is downloaded");
    assert.equal(failedUpdate(dir), null, "and no failed update is recorded or retried");
    assert.ok(lines.some((l) => l.includes("the workspace recommends the Scopebond Agent 0.99.0; install its package to update this computer")), lines.join("\n"));
    const m = seen(await tray(dir));
    assert.ok(m.row("Version").startsWith(`Scopebond ${agentVersion()}`) && !/update/i.test(m.row("Version").replace("up to date", "")), `the tray offers no update it cannot install: ${m.row("Version")}`);
  } finally { await service.stop(); }
});

test("the macOS package for every user asks its root updater, and a package that did not install is tried again later", async () => {
  const { mkdirSync, existsSync, readdirSync } = await import("node:fs");
  const ws = workspace();
  const { dir } = computer();
  ws.answers["client-version"] = { policy: "recommended", agent: null, hook: null, native_agent: "0.99.0" };
  const root = mkdtempSync(join(tmpdir(), "sb-b2-mac-updater-"));
  const macUpdater = { requests: join(root, "update-requests"), work: join(root, "updater"), result: join(root, "update-result.json") };
  mkdirSync(macUpdater.requests, { recursive: true });
  const lines = [];
  const service = await serve(dir, ws, { installKind: "per-machine", macUpdater, log: (line) => lines.push(line) });
  const requests = () => (/** @type {string[]} */ (readdirSync(macUpdater.requests)));
  try {
    await service.maintainNow();
    assert.equal(requests().length, 1);
    const request = join(macUpdater.requests, requests()[0]);
    assert.deepEqual(JSON.parse(readFileSync(request, "utf8")), { version: "0.99.0" }, "asked for the recommended version");
    assert.equal(ws.calls.download ?? 0, 0, "the person's agent downloads nothing itself");
    assert.ok(lines.some((l) => l.includes("asked the Scopebond updater to install")), lines.join("\n"));
    // The updater takes the request and reports that the package did not install.
    (await import("node:fs")).rmSync(request);
    writeFileSync(macUpdater.result, JSON.stringify({ at: new Date().toISOString(), version: "0.99.0", installed: false, reason: "the installer's signature is not valid" }));
    await service.maintainNow();
    assert.equal(failedUpdate(dir)?.version, "0.99.0", "recorded as a failed update");
    assert.equal(existsSync(request), false);
    assert.deepEqual(requests(), [], "and not asked again within the hour");
  } finally { await service.stop(); }
});
