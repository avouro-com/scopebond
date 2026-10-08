// SB391: the workspace's summary feeds the tray's names, links and Review count; the tray opens only links on the workspace
// this computer is connected to, and a workspace without the call simply leaves those rows out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchComputerSummary, sameOrigin } from "../dist/summary.js";

const connection = { url: "https://cloud.example.test", credential: "sbm_x" };
const answer = (status, body) => async (url, init) => {
  assert.equal(String(url), "https://cloud.example.test/v1/computer/summary");
  assert.equal(init.headers.authorization, "Bearer sbm_x");
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
};

test("names, links on the workspace's own origin, and the Review count", async () => {
  const summary = await fetchComputerSummary(connection, answer(200, {
    workspace_name: "Avouro", environment_name: "Staging US", computer_name: "LAPTOP",
    computer_url: "https://cloud.example.test/app/connections/gw-1", review_url: "https://evil.example/app/findings",
    open_reviews: 2, stage: "reporting",
  }));
  assert.equal(summary.workspace_name, "Avouro");
  assert.equal(summary.computer_url, "https://cloud.example.test/app/connections/gw-1");
  assert.equal(summary.review_url, null, "a link to another site is dropped");
  assert.equal(summary.open_reviews, 2);
});

test("a workspace without the call, or an unreachable one, gives no summary", async () => {
  assert.equal(await fetchComputerSummary(connection, answer(404, { error: "not_found" })), null);
  assert.equal(await fetchComputerSummary(connection, async () => { throw new Error("fetch failed"); }), null);
});

test("same origin means https on the workspace's own host (or loopback http)", () => {
  assert.equal(sameOrigin("https://cloud.example.test/app", "https://cloud.example.test"), true);
  assert.equal(sameOrigin("https://cloud.example.test.evil.example/app", "https://cloud.example.test"), false);
  assert.equal(sameOrigin("http://cloud.example.test/app", "http://cloud.example.test"), false);
  assert.equal(sameOrigin("http://127.0.0.1:8787/app", "http://127.0.0.1:8787"), true);
  assert.equal(sameOrigin("javascript:alert(1)", "https://cloud.example.test"), false);
});
