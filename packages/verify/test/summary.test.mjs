// Summary records: the closed shape and the cross-field rules, and the root over the covered receipts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSummary, summaryRoot, summarySigningInput, verifySummarySignature, verifySummaryCoverage, SUMMARY_DOMAIN } from "../dist/summary.js";
import { merkleTreeHash, receiptLeafHash } from "../dist/anchor.js";
import { canonical } from "@scopebond/policy-schema/canonical";
import { summarySchema, SUMMARY_DOMAIN as SCHEMA_DOMAIN, SUMMARY_RESULTS } from "@scopebond/policy-schema";

const hex = (c) => c.repeat(64);
const good = () => ({
  payload: {
    type: "scopebond:summary", version: "1.0", canonicalization: "RFC8785", evidence_class: "summary", summary_id: "sum_0123456789abcdef",
    attester: { kind: "gateway", kid: `key:${"0".repeat(16)}` }, session_id: null, harness: "claude",
    window: { kind: "interval", start: "2026-10-07T10:00:00.000Z", end: "2026-10-07T10:05:00.000Z" },
    receipt_count: 5, receipts_root: hex("a"), notable_count: 1,
    counts: [{ action_type: "shell.exec", result: "allow", program: "pnpm", cwd_digest: hex("b"), count: 4 }, { action_type: "file.read", result: "allow", program: null, cwd_digest: null, count: 1 }],
    dedupe: [{ key: hex("c"), count: 4, first_at: "2026-10-07T10:00:01.000Z", last_at: "2026-10-07T10:04:00.000Z" }],
    timestamp: "2026-10-07T10:05:01.000Z",
  },
  signature: { alg: "Ed25519", sig: "AAAA" },
});

test("a well-formed summary validates; the schema and this package agree on the domain and the results", () => {
  assert.deepEqual(validateSummary(good()), { valid: true, errors: [] });
  assert.equal(SUMMARY_DOMAIN, SCHEMA_DOMAIN);
  assert.deepEqual([...SUMMARY_RESULTS], summarySchema.properties.payload.properties.counts.items.properties.result.enum);
  assert.equal(summarySchema.additionalProperties, false);
  assert.equal(summarySchema.properties.payload.additionalProperties, false);
  assert.equal(summarySigningInput({ b: 1, a: 2 }), `${SUMMARY_DOMAIN}${canonical({ a: 2, b: 1 })}`);
});

test("the shape is closed and the cross-field rules hold", () => {
  const cases = [
    [(s) => { s.payload.extra = 1; }, /unknown member/],
    [(s) => { delete s.payload.receipts_root; }, /missing a member/],
    [(s) => { s.payload.evidence_class = "signed_intent"; }, /evidence_class/],
    [(s) => { s.payload.counts[0].result = "deny"; }, /counts\[0\]/],
    [(s) => { s.payload.counts[0].count = 3; }, /add up/],
    [(s) => { s.payload.window.end = "2026-10-07T09:00:00.000Z"; }, /window must not end/],
    [(s) => { s.payload.dedupe[0].last_at = "2026-10-07T11:00:00.000Z"; }, /inside the window/],
    [(s) => { s.payload.dedupe[0].count = 9; }, /repeats more/],
    [(s) => { s.payload.dedupe[0].count = 1; }, /dedupe\[0\]/],
    [(s) => { s.payload.attester.kid = "k1"; }, /attester/],
    [(s) => { s.signature.alg = "ES256"; }, /signature/],
    [(s) => { s.payload.counts = Array.from({ length: 501 }, () => s.payload.counts[1]); }, /at most 500/],
  ];
  for (const [mutate, message] of cases) {
    const s = good();
    mutate(s);
    const r = validateSummary(s);
    assert.equal(r.valid, false, String(message));
    assert.match(r.errors.join("; "), message);
  }
  assert.equal(validateSummary(null).valid, false);
  assert.equal(validateSummary({ payload: {}, signature: {}, x: 1 }).valid, false);
});

test("the root is the RFC 9162 tree hash over the receipts' leaf hashes, by timestamp then action id, whatever order they come in", async () => {
  const p = (t, id) => ({ timestamp: `2026-10-07T10:00:0${t}.000Z`, action_ref: { action_id: id } });
  const ordered = [p(1, "b"), p(2, "a"), p(2, "c"), p(3, "a")];
  assert.equal(await summaryRoot(ordered), await merkleTreeHash(await Promise.all(ordered.map(receiptLeafHash))));
  assert.equal(await summaryRoot([...ordered].reverse()), await summaryRoot(ordered));
  assert.notEqual(await summaryRoot(ordered.slice(1)), await summaryRoot(ordered));
});

test("malformed input never throws", async () => {
  assert.equal((await verifySummarySignature(null, "x")).valid, false);
  assert.equal((await verifySummarySignature(good(), "not a key")).valid, false);
  assert.equal((await verifySummaryCoverage(null, [])).valid, false);
  assert.equal((await verifySummaryCoverage(good(), [null])).valid, false);
});
