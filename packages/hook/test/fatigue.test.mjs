// How often the person was interrupted: toasts and prompts counted per local day in fatigue.json and sent on the rules check
// as `x-scopebond-fatigue: toasts=n;prompts=n;day=YYYY-MM-DD`. Counts only; a new day starts again from zero.

import { ENFORCE } from "./enforce-all.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffold, policyBuilds, syncPolicy, recordFatigue, readFatigue, fatigueHeaderValue, localDay, FATIGUE_FILE } from "../dist/index.js";

const temp = () => mkdtempSync(join(tmpdir(), "sb-fatigue-"));

test("toasts and prompts are counted per local day; a new day starts from zero", () => {
  const dir = temp();
  const day1 = new Date(2026, 9, 20, 9, 0);
  const day2 = new Date(2026, 9, 21, 9, 0);
  assert.equal(fatigueHeaderValue(dir), null, "nothing counted, nothing sent");
  recordFatigue(dir, "toast", day1);
  recordFatigue(dir, "toast", day1);
  recordFatigue(dir, "prompt", day1);
  assert.deepEqual(readFatigue(dir), { v: 1, day: "2026-10-20", toasts: 2, prompts: 1 });
  assert.equal(fatigueHeaderValue(dir), "toasts=2;prompts=1;day=2026-10-20");
  recordFatigue(dir, "prompt", day2);
  assert.equal(fatigueHeaderValue(dir), "toasts=0;prompts=1;day=2026-10-21");
  assert.equal(localDay(day2), "2026-10-21");
});

test("a damaged file counts again from zero, and is never sent", () => {
  const dir = temp();
  writeFileSync(join(dir, FATIGUE_FILE), JSON.stringify({ v: 1, day: "2026-10-20", toasts: -1, prompts: "x" }));
  assert.equal(fatigueHeaderValue(dir), null);
  recordFatigue(dir, "toast", new Date(2026, 9, 20));
  assert.equal(readFatigue(dir).toasts, 1);
});

test("the rules check carries the counts", async () => {
  const dir = temp();
  const { agentKid } = scaffold(dir, ENFORCE);
  writeFileSync(join(dir, "cloud.json"), JSON.stringify({ url: "https://cloud.example.test", credential: "sbm_x", credential_id: "c", organization_id: "org-f", environment_id: "env-1", gateway_id: "gw-f", attester_kid: "k", scopes: [], expires_at: "2099-01-01T00:00:00Z" }));
  recordFatigue(dir, "prompt");
  const calls = [];
  const fetchImpl = async (url, init = {}) => { calls.push({ url: String(url), headers: init.headers ?? {} }); return new Response(null, { status: 204 }); };
  await syncPolicy(dir, { agentKid, hookVersion: "0.40.0", policyBuilds, fetchImpl });
  const check = calls.find((c) => c.url.endsWith("/v1/policy"));
  assert.equal(check.headers["x-scopebond-fatigue"], `toasts=0;prompts=1;day=${localDay()}`);
});
