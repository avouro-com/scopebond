// Whether this computer keeps itself delivering and up to date: the version the workspace recommends
// (read from the rules check) and whether the Scopebond Agent runs, each with the one command that fixes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPresence, healthLines, olderVersion, recommendedFrom } from "../dist/client-health.js";

const headers = (values) => ({ get: (name) => values[name] ?? null });

test("reads the recommended versions from a rules-check answer, and only well-formed ones", () => {
  assert.deepEqual(recommendedFrom(headers({ "x-scopebond-recommended-hook": "0.19.2", "x-scopebond-recommended-agent": "0.4.4" })), { hook: "0.19.2", agent: "0.4.4" });
  assert.deepEqual(recommendedFrom(headers({ "x-scopebond-recommended-hook": "0.19.2" })), { hook: "0.19.2", agent: null });
  assert.equal(recommendedFrom(headers({ "x-scopebond-recommended-hook": "latest; rm -rf /" })), null);
  assert.equal(recommendedFrom(headers({})), null);
  assert.equal(recommendedFrom(undefined), null);
});

test("compares versions by number", () => {
  assert.equal(olderVersion("0.16.0", "0.19.2"), true);
  assert.equal(olderVersion("0.9.0", "0.10.0"), true);
  assert.equal(olderVersion("0.19.2", "0.19.2"), false);
  assert.equal(olderVersion("1.0.0", "0.19.2"), false);
  assert.equal(olderVersion(null, "0.19.2"), false);
  assert.equal(olderVersion("dev", "0.19.2"), false);
});

test("tells a running agent from a stopped or missing one", () => {
  const home = mkdtempSync(join(tmpdir(), "sb-health-"));
  assert.deepEqual(agentPresence(home), { state: "not_installed" });
  writeFileSync(join(home, "agent.key"), ""); // the hook's own signing key, written on init
  assert.deepEqual(agentPresence(home), { state: "not_installed" });
  writeFileSync(join(home, "agent-launch.cmd"), "");
  assert.deepEqual(agentPresence(home), { state: "stopped" });
  writeFileSync(join(home, "agent.json"), JSON.stringify({ port: 1, token: "secret", pid: 4242, started_at: 1, version: "0.4.4" }));
  assert.deepEqual(agentPresence(home, () => false), { state: "stopped" });
  assert.deepEqual(agentPresence(home, (pid) => pid === 4242), { state: "running", version: "0.4.4" });
  assert.deepEqual(agentPresence(home, () => true).state, "running");
});

test("names the update and the agent fix; says nothing is wrong when both are current", () => {
  const stale = healthLines({ hookVersion: "0.16.0", recommended: { hook: "0.19.2", agent: "0.4.4" }, agent: { state: "not_installed" }, connected: true, workspaceUrl: "https://cloud.example" });
  assert.equal(stale.length, 2);
  assert.match(stale[0].text, /Scopebond 0\.16\.0 is older than the 0\.19\.2 your workspace recommends\. Update: npx(\.cmd)? -y @scopebond\/hook@0\.19\.2 install$/);
  assert.equal(stale[0].problem, true);
  assert.match(stale[1].text, /not installed, so records send only while a coding agent works and nothing installs updates\. Install it: npx(\.cmd)? -y @scopebond\/agent@0\.4\.4 setup https:\/\/cloud\.example$/);
  const stopped = healthLines({ hookVersion: "0.19.2", recommended: { hook: "0.19.2", agent: "0.4.4" }, agent: { state: "stopped" }, connected: true });
  assert.deepEqual(stopped.map((l) => l.problem), [true]);
  assert.match(stopped[0].text, /installed but not running.*autostart on$/);
  const fine = healthLines({ hookVersion: "0.19.2", recommended: { hook: "0.19.2", agent: "0.4.4" }, agent: { state: "running", version: "0.4.4" }, connected: true });
  assert.deepEqual(fine.map((l) => l.problem), [false]);
  assert.match(fine[0].text, /^running 0\.4\.4/);
  // A computer that keeps records only for itself is told about updates, not about the agent.
  assert.deepEqual(healthLines({ hookVersion: "0.19.2", recommended: null, agent: { state: "not_installed" }, connected: false }), []);
  // The agent updates itself; while it runs an older version is said, not failed on.
  const updating = healthLines({ hookVersion: "0.19.2", recommended: { hook: "0.19.2", agent: "0.4.4" }, agent: { state: "running", version: "0.4.1" }, connected: true });
  assert.deepEqual(updating.map((l) => [l.problem, /updates itself to 0\.4\.4/.test(l.text)]), [[false, true]]);
});
