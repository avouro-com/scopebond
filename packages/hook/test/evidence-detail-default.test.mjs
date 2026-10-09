// A computer that has no evidence detail of its own and no workspace that names one sends the standard detail: notable
// receipts in full, routine ones as signed summaries. Full detail is sent only when the workspace or this computer's own
// setting asks for it.
import { ENFORCE } from "./enforce-all.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffold, policyBuilds, syncPolicy, evidenceDetail, summaryOptions } from "../dist/index.js";

function connected() {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-detail-default-"));
  const { agentKid } = scaffold(dir, ENFORCE);
  writeFileSync(join(dir, "cloud.json"), JSON.stringify({ url: "https://cloud.example.test", credential: "sbm_x", credential_id: "c", organization_id: "o", environment_id: "env-1", gateway_id: "gw-default-1", attester_kid: "k", scopes: [], expires_at: "2099-01-01T00:00:00Z" }));
  return { dir, agentKid };
}
const workspace = (detail) => async (url) => {
  if (String(url).endsWith("/v1/policy/ack")) return new Response("{}", { status: 200 });
  return new Response(null, { status: 204, headers: detail ? { "x-scopebond-evidence-detail": detail } : {} });
};

test("a fresh computer sends the standard detail", () => {
  const { dir } = connected();
  try {
    assert.equal(evidenceDetail(dir), "standard");
    assert.equal(summaryOptions(dir).detail(), "standard");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a fresh computer with no folder at all reads as standard", () => {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-detail-empty-"));
  try { assert.equal(evidenceDetail(dir), "standard"); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a rules check that names no level keeps the standard detail", async () => {
  const { dir, agentKid } = connected();
  try {
    await syncPolicy(dir, { agentKid, hookVersion: "0.22.0", policyBuilds, fetchImpl: workspace(null) });
    assert.equal(evidenceDetail(dir), "standard");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a workspace that sets full detail keeps full", async () => {
  const { dir, agentKid } = connected();
  try {
    await syncPolicy(dir, { agentKid, hookVersion: "0.22.0", policyBuilds, fetchImpl: workspace("full") });
    assert.equal(evidenceDetail(dir), "full");
    assert.equal(summaryOptions(dir).detail(), "full");
    await syncPolicy(dir, { agentKid, hookVersion: "0.22.0", policyBuilds, fetchImpl: workspace(null) });
    assert.equal(evidenceDetail(dir), "full", "a later check without the header keeps the workspace's full");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an explicit local full setting keeps full", () => {
  const { dir } = connected();
  try {
    writeFileSync(join(dir, "managed-meta.json"), JSON.stringify({ evidence_detail: "full" }));
    assert.equal(evidenceDetail(dir), "full");
    assert.equal(summaryOptions(dir).detail(), "full");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an unknown local value falls back to standard, never full", () => {
  const { dir } = connected();
  try {
    writeFileSync(join(dir, "managed-meta.json"), JSON.stringify({ evidence_detail: "everything" }));
    assert.equal(evidenceDetail(dir), "standard");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
