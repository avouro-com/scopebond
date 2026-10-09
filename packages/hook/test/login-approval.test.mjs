// What `login` says once a workspace approved its code, and how long it waits when the workspace is busy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalSummary, retryAfterSeconds } from "../dist/login-approval.js";

test("names the workspace, where its data is and who approved, from what the workspace answered", () => {
  assert.equal(approvalSummary({ workspace: { name: "Acme", region: "eu" }, approved_by: "dana@acme.example" }), 'Approved into workspace "Acme" (data in the EU) by dana@acme.example.');
  assert.equal(approvalSummary({ workspace: { name: "Acme", region: "us" } }), 'Approved into workspace "Acme" (data in the US).');
  assert.equal(approvalSummary({ enrollment: {} }), null, "an older workspace says nothing: nothing is invented");
  assert.equal(approvalSummary({ workspace: { name: "Ac\u001b[2Jme\u202E" } }), 'Approved into workspace "Ac [2Jme".', "no terminal control or direction characters");
});

test("a busy workspace's Retry-After is honoured within bounds", () => {
  assert.equal(retryAfterSeconds("30"), 30);
  assert.equal(retryAfterSeconds("9999"), 120);
  assert.equal(retryAfterSeconds(null), 10);
  assert.equal(retryAfterSeconds("soon"), 10);
});
