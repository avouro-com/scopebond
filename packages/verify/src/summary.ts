// Summary records (scopebond:summary v1, evidence class "summary"): a signed stand-in for routine receipts when a computer
// sends them, with an RFC 9162 Merkle Tree Hash over the receipts it covers. Every action keeps its own signed receipt on
// the computer; a summary lets a workspace store one record for many routine ones, and anybody holding the full receipts
// can check them against it. WebCrypto only, like the rest of this package.
//
// What is checked:
//   validateSummary          the closed shape (mirrors summary.schema.json) and the cross-field rules: the window runs
//                            forwards, the counts add up to receipt_count, each repeat lies in the window and repeats no
//                            more than the receipts covered.
//   verifySummarySignature   the Ed25519 signature over the domain "scopebond:summary/v1\n" plus the canonical payload,
//                            and that the key is the one the payload names.
//   verifySummaryCoverage    given the covered receipts: their number, the root, that each lies in the window, that none
//                            is a denied, overridden, approved or timed-out action, and the totals per action type and
//                            result.

import { canonical } from "@scopebond/policy-schema/canonical";
import { merkleTreeHash, receiptLeafHash } from "./anchor.js";
import { deriveKeyId, importEd25519PublicKey, SUPPORTED_ATTESTER_KINDS, SUPPORTED_SIGNATURE_ALGS, type SignatureVerification } from "./signature.js";
import type { ValidationResult } from "./validate.js";

export const SUMMARY_TYPE = "scopebond:summary" as const;
export const SUMMARY_DOMAIN = "scopebond:summary/v1\n";
const RESULTS = new Set(["allow", "not_evaluated"]);
const HEX64 = /^[0-9a-f]{64}$/;
const KID = /^key:[0-9a-f]{16}$/;
const HARNESS = /^[a-z][a-z0-9-]{0,39}$/;
const MAX = 1_000_000;

export interface SummaryCount { action_type: string; result: "allow" | "not_evaluated"; program: string | null; cwd_digest: string | null; count: number }
export interface SummaryRepeat { key: string; count: number; first_at: string; last_at: string }
export interface SummaryPayload {
  type: typeof SUMMARY_TYPE;
  version: "1.0";
  canonicalization: "RFC8785";
  evidence_class: "summary";
  summary_id: string;
  attester: { kind: "gateway"; kid: string };
  session_id?: string | null;
  harness?: string | null;
  window: { kind: "interval" | "session"; start: string; end: string };
  receipt_count: number;
  receipts_root: string;
  notable_count: number;
  counts: SummaryCount[];
  dedupe: SummaryRepeat[];
  timestamp: string;
}
export interface SummaryRecord { payload: SummaryPayload; signature: { alg: "Ed25519"; sig: string } }

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const onlyKeys = (o: Obj, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));
const hasKeys = (o: Obj, keys: readonly string[]) => keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
const isInt = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const isText = (v: unknown, min: number, max: number) => typeof v === "string" && v.length >= min && v.length <= max;
const isTime = (v: unknown) => typeof v === "string" && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));

const PAYLOAD_KEYS = ["type", "version", "canonicalization", "evidence_class", "summary_id", "attester", "session_id", "harness", "window",
  "receipt_count", "receipts_root", "notable_count", "counts", "dedupe", "timestamp"] as const;
const PAYLOAD_REQUIRED = PAYLOAD_KEYS.filter((k) => k !== "session_id" && k !== "harness");

/** The closed shape of a summary record and its cross-field rules. Never throws. */
export function validateSummary(record: unknown): ValidationResult {
  const errors: string[] = [];
  const fail = (e: string) => { errors.push(e); return { valid: false, errors }; };
  if (!isObj(record) || !onlyKeys(record, ["payload", "signature"]) || !hasKeys(record, ["payload", "signature"])) return fail("a summary is { payload, signature }");
  const sig = record.signature;
  if (!isObj(sig) || !onlyKeys(sig, ["alg", "sig"]) || sig.alg !== "Ed25519" || !isText(sig.sig, 1, 200)) errors.push("signature must be { alg: Ed25519, sig }");
  const p = record.payload;
  if (!isObj(p)) return fail("payload must be an object");
  if (!onlyKeys(p, PAYLOAD_KEYS)) errors.push(`payload has an unknown member (allowed: ${PAYLOAD_KEYS.join(", ")})`);
  if (!hasKeys(p, PAYLOAD_REQUIRED)) return fail(`payload is missing a member (required: ${PAYLOAD_REQUIRED.join(", ")})`);
  if (p.type !== SUMMARY_TYPE) errors.push("type must be scopebond:summary");
  if (p.version !== "1.0") errors.push("version must be 1.0");
  if (p.canonicalization !== "RFC8785") errors.push("canonicalization must be RFC8785");
  if (p.evidence_class !== "summary") errors.push("evidence_class must be summary");
  if (!isText(p.summary_id, 16, 200)) errors.push("summary_id must be 16 to 200 characters");
  const a = p.attester;
  if (!isObj(a) || !onlyKeys(a, ["kind", "kid"]) || a.kind !== "gateway" || typeof a.kid !== "string" || !KID.test(a.kid)) errors.push("attester must be { kind: gateway, kid: key:<16 hex> }");
  if (p.session_id !== undefined && p.session_id !== null && !isText(p.session_id, 1, 200)) errors.push("session_id must be null or 1 to 200 characters");
  if (p.harness !== undefined && p.harness !== null && (typeof p.harness !== "string" || !HARNESS.test(p.harness))) errors.push("harness must be null or a short lowercase name");
  const w = p.window;
  let start = NaN, end = NaN;
  if (!isObj(w) || !onlyKeys(w, ["kind", "start", "end"]) || (w.kind !== "interval" && w.kind !== "session") || !isTime(w.start) || !isTime(w.end)) errors.push("window must be { kind: interval | session, start, end }");
  else { start = Date.parse(w.start as string); end = Date.parse(w.end as string); if (start > end) errors.push("window must not end before it starts"); }
  if (!isInt(p.receipt_count, 1, MAX)) errors.push("receipt_count must be an integer from 1");
  if (typeof p.receipts_root !== "string" || !HEX64.test(p.receipts_root)) errors.push("receipts_root must be 64 lowercase hex");
  if (!isInt(p.notable_count, 0, MAX)) errors.push("notable_count must be an integer from 0");
  if (!isTime(p.timestamp)) errors.push("timestamp must be an RFC 3339 time");
  let counted = 0;
  if (!Array.isArray(p.counts) || p.counts.length > 500) errors.push("counts must be a list of at most 500");
  else for (const [i, c] of p.counts.entries()) {
    if (!isObj(c) || !onlyKeys(c, ["action_type", "result", "program", "cwd_digest", "count"]) || !hasKeys(c, ["action_type", "result", "program", "cwd_digest", "count"])
      || !isText(c.action_type, 1, 100) || !RESULTS.has(c.result as string) || (c.program !== null && !isText(c.program, 1, 100))
      || (c.cwd_digest !== null && (typeof c.cwd_digest !== "string" || !HEX64.test(c.cwd_digest))) || !isInt(c.count, 1, MAX)) { errors.push(`counts[${i}] is malformed`); continue; }
    counted += c.count as number;
  }
  if (Array.isArray(p.counts) && isInt(p.receipt_count, 1, MAX) && counted !== p.receipt_count) errors.push("the counts must add up to receipt_count");
  if (!Array.isArray(p.dedupe) || p.dedupe.length > 500) errors.push("dedupe must be a list of at most 500");
  else for (const [i, d] of p.dedupe.entries()) {
    if (!isObj(d) || !onlyKeys(d, ["key", "count", "first_at", "last_at"]) || typeof d.key !== "string" || !HEX64.test(d.key) || !isInt(d.count, 2, MAX)
      || !isTime(d.first_at) || !isTime(d.last_at)) { errors.push(`dedupe[${i}] is malformed`); continue; }
    const first = Date.parse(d.first_at as string), last = Date.parse(d.last_at as string);
    if (first > last || (Number.isFinite(start) && (first < start || last > end))) errors.push(`dedupe[${i}] must lie inside the window`);
    if (isInt(p.receipt_count, 1, MAX) && (d.count as number) > (p.receipt_count as number)) errors.push(`dedupe[${i}] repeats more than the receipts covered`);
  }
  return { valid: errors.length === 0, errors };
}

/** The bytes a summary's signature covers. */
export function summarySigningInput(payload: unknown): string {
  return SUMMARY_DOMAIN + canonical(payload);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Verify a summary's signature and key binding (same result shape as receipts). Never throws. */
export async function verifySummarySignature(record: unknown, publicKey: string | JsonWebKey): Promise<SignatureVerification> {
  const result: SignatureVerification = { valid: false, signature_valid: false, key_binding_valid: false, alg_supported: false, attester_kind_supported: false };
  const r = record as { payload?: { type?: unknown; attester?: { kind?: unknown; kid?: unknown } }; signature?: { alg?: unknown; sig?: unknown } };
  if (!r || typeof r !== "object" || !isObj(r.payload) || r.payload.type !== SUMMARY_TYPE || !r.signature || typeof r.signature.sig !== "string") return result;
  result.alg_supported = (SUPPORTED_SIGNATURE_ALGS as readonly unknown[]).includes(r.signature.alg);
  result.attester_kind_supported = (SUPPORTED_ATTESTER_KINDS as readonly unknown[]).includes(r.payload.attester?.kind);
  if (!result.alg_supported) return result;
  try {
    const { key, jwk } = await importEd25519PublicKey(publicKey);
    const subtle = (globalThis as { crypto: Crypto }).crypto.subtle;
    result.signature_valid = await subtle.verify({ name: "Ed25519" }, key, base64ToBytes(r.signature.sig), new TextEncoder().encode(summarySigningInput(r.payload)));
    result.key_binding_valid = typeof r.payload.attester?.kid === "string" && (await deriveKeyId(jwk)) === r.payload.attester.kid;
  } catch {
    return result;
  }
  result.valid = result.signature_valid && result.key_binding_valid && result.attester_kind_supported;
  return result;
}

/** The order a summary's root is taken in: by timestamp, then action id, then the canonical payload. Anybody holding the
 *  receipts can reproduce it, whatever order they were stored or sent in. */
export function summaryOrder<T>(receiptPayloads: readonly T[]): T[] {
  const key = (p: unknown) => {
    const x = (p ?? {}) as { timestamp?: unknown; action_ref?: { action_id?: unknown } };
    return [String(x.timestamp ?? ""), String(x.action_ref?.action_id ?? ""), canonical(p)] as const;
  };
  return [...receiptPayloads].map((p) => ({ p, k: key(p) }))
    .sort((a, b) => (a.k[0] < b.k[0] ? -1 : a.k[0] > b.k[0] ? 1 : a.k[1] < b.k[1] ? -1 : a.k[1] > b.k[1] ? 1 : a.k[2] < b.k[2] ? -1 : a.k[2] > b.k[2] ? 1 : 0))
    .map(({ p }) => p);
}

/** The root a summary carries over the receipts it covers, taken in `summaryOrder`. */
export async function summaryRoot(receiptPayloads: readonly unknown[]): Promise<string> {
  return merkleTreeHash(await Promise.all(summaryOrder(receiptPayloads).map((p) => receiptLeafHash(p))));
}

export interface SummaryCoverage {
  valid: boolean;
  count_valid: boolean;
  root_valid: boolean;
  /** Every covered receipt's timestamp lies inside the window. */
  window_valid: boolean;
  /** None is a denied, overridden, approved or timed-out action. */
  routine_only: boolean;
  /** The receipts' totals per action type and result equal the summary's. */
  totals_valid: boolean;
}

/** Check a summary against the full receipts it covers. Never throws. */
export async function verifySummaryCoverage(record: unknown, receipts: ReadonlyArray<{ payload?: unknown }>): Promise<SummaryCoverage> {
  const out: SummaryCoverage = { valid: false, count_valid: false, root_valid: false, window_valid: false, routine_only: false, totals_valid: false };
  const p = (record as { payload?: SummaryPayload } | null)?.payload;
  if (!p || !Array.isArray(receipts) || !p.window || !Array.isArray(p.counts)) return out;
  const payloads = receipts.map((r) => r?.payload as Obj | undefined);
  if (payloads.some((x) => !isObj(x))) return out;
  out.count_valid = payloads.length === p.receipt_count;
  try { out.root_valid = out.count_valid && (await summaryRoot(payloads)) === p.receipts_root; } catch { out.root_valid = false; }
  const start = Date.parse(p.window.start), end = Date.parse(p.window.end);
  out.window_valid = payloads.every((x) => { const t = Date.parse(String(x!.timestamp)); return t >= start && t <= end; });
  out.routine_only = payloads.every((x) => RESULTS.has(String(x!.realtime_result)) && x!.override === undefined);
  const totals = (rows: Array<[string, string, number]>) => {
    const m = new Map<string, number>();
    for (const [type, result, n] of rows) m.set(`${type}\u0000${result}`, (m.get(`${type}\u0000${result}`) ?? 0) + n);
    return [...m.entries()].sort().map(([k, v]) => `${k}=${v}`).join("\n");
  };
  out.totals_valid = totals(payloads.map((x) => [String((x!.intent as Obj | undefined)?.action_type ?? ""), String(x!.realtime_result), 1]))
    === totals(p.counts.map((c) => [c.action_type, c.result, c.count]));
  out.valid = out.count_valid && out.root_valid && out.window_valid && out.routine_only && out.totals_valid;
  return out;
}
