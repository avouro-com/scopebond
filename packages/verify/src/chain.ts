// Evidence-chain heads and published anchor lists from a Scopebond workspace.
//
// A workspace keeps one chain per environment (or per shard of one): an ingest sequence number for every record it
// admits, and a chain of evidence segments, each naming the digest of the segment before it. Every delivery answer carries
// the chain's head (the newest admitted sequence number and the newest segment), which the computer keeps; each day's
// newest head per chain is published as a signed list in a public, append-only log. A chain is named only by an opaque
// `anchor_id` (a salted hash), never by a workspace name or id.
//
// What this module checks:
//   - a list's and a head's Ed25519 signatures against the key the list publishes (whose id is derived from it);
//   - that heads agree with each other, wherever they come from (kept by the computer, or published): a chain's sequence
//     never goes back, and one sequence number never ends two different segments. "Goes back" is judged in issue order and
//     also in the computer's own order of deliveries, which the workspace cannot choose (it signs `issued_at`, so it could
//     stamp a lower head before a higher one it already handed out);
//   - downloaded evidence segments against the heads: each segment's digest, canonical form, leaves, Merkle root and
//     sequence numbers, the previous-segment links, and that every head's segment is still in the chain its newest head
//     names. A deleted, truncated or re-chained segment then contradicts a head somebody outside the workspace holds.
//
// Signatures: Ed25519 over "scopebond:chain-head/v1\n" + RFC 8785 canonical(head), and over
// "scopebond:chain-anchors/v1\n" + canonical(the list without `signed` and `signature`). A key's id is "seg_" + the first
// 16 hex of SHA-256 over its base64 SPKI. Pure and runtime-agnostic: WebCrypto only.

import { canonical } from "@scopebond/policy-schema/canonical";
import { merkleRootV1, sha256Hex } from "./anchor.js";
import { deriveKeyId, importEd25519PublicKey, verifyReceiptSignature } from "./signature.js";
import { SUMMARY_TYPE, verifySummarySignature } from "./summary.js";

export const CHAIN_HEAD_TYPE = "scopebond:chain-head" as const;
export const CHAIN_HEAD_CONTEXT = "scopebond:chain-head/v1\n";
export const ANCHOR_LIST_TYPE = "scopebond:chain-anchors" as const;
export const ANCHOR_LIST_CONTEXT = "scopebond:chain-anchors/v1\n";
export const SEGMENT_TYPE = "scopebond:evidence-segment" as const;

export interface ChainHead {
  type: typeof CHAIN_HEAD_TYPE;
  version: 1;
  /** The chain's opaque name (64 hex). */
  anchor_id: string;
  /** The highest sequence number the chain had admitted. */
  ingest_seq: number;
  /** The chain's newest evidence segment, or null before the first. */
  segment: { digest: string; last_ingest_seq: number } | null;
  issued_at: string;
}

export interface ChainSignature { alg: "Ed25519"; kid: string; sig: string }
export interface SignedChainHead { head: ChainHead; signed: boolean; signature: ChainSignature | null }
export interface AnchorKey { alg: "Ed25519"; kid: string; public_key_spki: string }

/** This computer's own clock around a head it kept (ISO 8601), never the workspace's: `sent_at`, when the delivery whose
 *  answer carried the head was sent (the workspace issued the head after it); `received_at`, a time by which this computer
 *  held the head. A head kept before these were recorded has neither, or only `received_at`. `clock` names the computer
 *  whose clock took them (the same for every head one computer keeps): a folder two computers share holds both, and one
 *  computer's times do not order the other's. A head kept without it is compared with every clock, as before. */
export interface HeadTiming { sent_at?: string; received_at?: string; clock?: string }
/** A head as this computer keeps it: the workspace's signed head and, beside it, this computer's times. */
export type KeptChainHead = SignedChainHead & { local?: HeadTiming };

export interface AnchorList {
  type: typeof ANCHOR_LIST_TYPE;
  version: 1;
  date: string;
  key: AnchorKey | null;
  heads: SignedChainHead[];
  signed: boolean;
  signature: ChainSignature | null;
}

const HEX64 = /^[0-9a-f]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isSeq = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const onlyKeys = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).sort().join(",") === [...keys].sort().join(",");
const short = (hex: string) => hex.slice(0, 12);

/** A well-formed signed chain head (closed shape; the signature itself is checked separately). */
export function isSignedChainHead(value: unknown): value is SignedChainHead {
  if (!isObj(value) || !isObj(value.head) || typeof value.signed !== "boolean") return false;
  const h = value.head;
  if (!onlyKeys(h, ["type", "version", "anchor_id", "ingest_seq", "segment", "issued_at"])) return false;
  if (h.type !== CHAIN_HEAD_TYPE || h.version !== 1 || typeof h.anchor_id !== "string" || !HEX64.test(h.anchor_id) || !isSeq(h.ingest_seq)) return false;
  if (typeof h.issued_at !== "string" || !Number.isFinite(Date.parse(h.issued_at))) return false;
  if (h.segment !== null) {
    if (!isObj(h.segment) || !onlyKeys(h.segment, ["digest", "last_ingest_seq"]) || typeof h.segment.digest !== "string" || !HEX64.test(h.segment.digest)) return false;
    if (!isSeq(h.segment.last_ingest_seq) || h.segment.last_ingest_seq > h.ingest_seq) return false;
  }
  if (value.signed) {
    const s = value.signature;
    return isObj(s) && s.alg === "Ed25519" && typeof s.kid === "string" && typeof s.sig === "string";
  }
  return value.signature === null;
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function ed25519Verify(spkiB64: string, message: string, sigB64: string): Promise<boolean> {
  try {
    const subtle = globalThis.crypto.subtle;
    const key = await subtle.importKey("spki", base64ToBytes(spkiB64), { name: "Ed25519" }, false, ["verify"]);
    return await subtle.verify({ name: "Ed25519" }, key, base64ToBytes(sigB64), new TextEncoder().encode(message));
  } catch { return false; }
}

/** The id of a published segment key: "seg_" + the first 16 hex of SHA-256 over its base64 SPKI. */
export async function segmentKeyId(publicKeySpki: string): Promise<string> {
  return "seg_" + (await sha256Hex(publicKeySpki)).slice(0, 16);
}

/** The exact string a head's signature covers. */
export const chainHeadSigningInput = (head: ChainHead): string => CHAIN_HEAD_CONTEXT + canonical(head);

/** Does this signed head verify under `key` (and name it)? Never throws; an unsigned head, or a key that is not one, is
 *  false. */
export async function verifyChainHeadSignature(signed: SignedChainHead, key: AnchorKey): Promise<boolean> {
  try {
    if (!isObj(key) || typeof key.kid !== "string" || typeof key.public_key_spki !== "string") return false;
    if (!isSignedChainHead(signed) || !signed.signed || !signed.signature || signed.signature.kid !== key.kid) return false;
    if ((await segmentKeyId(key.public_key_spki)) !== key.kid) return false;
    // canonical() refuses text that is not well-formed Unicode: such a head was never signed.
    return await ed25519Verify(key.public_key_spki, chainHeadSigningInput(signed.head), signed.signature.sig);
  } catch { return false; }
}

export interface AnchorListCheck {
  /** Well formed, and every signature present verifies under the published key. */
  valid: boolean;
  /** The list is signed (an unsigned list can still be compared, but proves nothing about who published it). */
  signed: boolean;
  kid: string | null;
  heads: number;
  problems: string[];
}

/** Check one day's published list: its shape, that its key id matches its key, the list signature, and every head's
 *  signature. Never throws: a list it cannot check is not valid. */
export async function verifyAnchorList(value: unknown): Promise<AnchorListCheck> {
  try { return await checkAnchorList(value); }
  catch (error) { return { valid: false, signed: false, kid: null, heads: 0, problems: [`the list could not be checked (${(error as Error)?.message ?? String(error)})`] }; }
}

async function checkAnchorList(value: unknown): Promise<AnchorListCheck> {
  const problems: string[] = [];
  const out = (signed: boolean, kid: string | null, heads: number): AnchorListCheck => ({ valid: problems.length === 0, signed, kid, heads, problems });
  if (!isObj(value) || value.type !== ANCHOR_LIST_TYPE || value.version !== 1 || typeof value.date !== "string" || !DAY.test(value.date) || !Array.isArray(value.heads)) {
    problems.push("not a scopebond:chain-anchors list");
    return out(false, null, 0);
  }
  if (!onlyKeys(value, ["type", "version", "date", "key", "heads", "signed", "signature"])) problems.push("the list has unexpected members");
  const heads = value.heads as unknown[];
  const seen = new Set<string>();
  for (const [i, h] of heads.entries()) {
    if (!isSignedChainHead(h)) { problems.push(`head ${i} is malformed`); continue; }
    if (seen.has(h.head.anchor_id)) problems.push(`chain ${short(h.head.anchor_id)} is listed twice`);
    seen.add(h.head.anchor_id);
    if (h.head.issued_at.slice(0, 10) !== value.date) problems.push(`chain ${short(h.head.anchor_id)}: its head was issued on another day`);
  }
  const key = value.key;
  if (value.signed !== true) {
    if (value.signed !== false || value.signature !== null) problems.push("an unsigned list must say signed: false and carry no signature");
    for (const h of heads) if (isSignedChainHead(h) && h.signed) problems.push(`chain ${short(h.head.anchor_id)}: a signed head in an unsigned list cannot be checked`);
    return out(false, null, heads.length);
  }
  if (!isObj(key) || key.alg !== "Ed25519" || typeof key.kid !== "string" || typeof key.public_key_spki !== "string") {
    problems.push("a signed list must publish its key");
    return out(true, null, heads.length);
  }
  const anchorKey = key as unknown as AnchorKey;
  if ((await segmentKeyId(anchorKey.public_key_spki)) !== anchorKey.kid) problems.push("the key id does not name the published key");
  const signature = value.signature;
  const body = { type: value.type, version: value.version, date: value.date, key: value.key, heads: value.heads };
  // A list with text that is not well-formed Unicode has no canonical form, so no signature over it can verify.
  let signingInput: string | null = null;
  try { signingInput = ANCHOR_LIST_CONTEXT + canonical(body); } catch { /* reported below */ }
  if (!isObj(signature) || signature.kid !== anchorKey.kid || typeof signature.sig !== "string" || signingInput === null
      || !(await ed25519Verify(anchorKey.public_key_spki, signingInput, signature.sig))) {
    problems.push("the list signature does not verify");
  }
  for (const h of heads) {
    if (!isSignedChainHead(h)) continue;
    if (!h.signed) continue; // a head recorded before the key was set is listed as given, unsigned
    if (h.signature!.kid !== anchorKey.kid) { problems.push(`chain ${short(h.head.anchor_id)}: its head is signed by another key (${h.signature!.kid})`); continue; }
    if (!(await verifyChainHeadSignature(h, anchorKey))) problems.push(`chain ${short(h.head.anchor_id)}: its head signature does not verify`);
  }
  return out(true, anchorKey.kid, heads.length);
}

export interface HeadsCheck {
  ok: boolean;
  problems: string[];
  /** Chains seen in the kept heads. */
  chains: number;
  /** Published heads that name a chain the kept heads name. */
  matched: number;
}

type Sourced = { head: ChainHead; from: "kept" | "published"; sentAt: number; heldBy: number; clock: string | null };

/** One of this computer's own times kept beside a head, in ms; NaN when there is none (or it is not a time). */
const localTime = (h: KeptChainHead, field: "sent_at" | "received_at"): number => {
  const local = (h as { local?: unknown }).local;
  const value = isObj(local) ? local[field] : undefined;
  return typeof value === "string" ? Date.parse(value) : NaN;
};

/** The clock a kept head's times were taken on, or null when the head does not name one. */
const localClock = (h: KeptChainHead): string | null => {
  const local = (h as { local?: unknown }).local;
  const value = isObj(local) ? local.clock : undefined;
  return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : null;
};

/** Do the heads agree? A chain's sequence number never goes back, and one sequence number never ends two different
 *  segments. Kept heads (from this computer's delivery answers, with the times it kept beside them) and published heads
 *  are merged per chain. "Never goes back" is checked two ways, and either one failing is reported:
 *   - in this computer's own order, which the workspace cannot choose: a kept head that answered a delivery sent after
 *     another kept head was held was issued after it, so its sequence number is not lower (deliveries in flight together
 *     may be answered out of order, and are not compared). Times are compared on one clock only: heads that name two
 *     different clocks are not compared, and a head held before its delivery was sent was timed across a clock step back,
 *     so its sent time orders nothing;
 *   - in issue order (`issued_at`), which also covers published heads and heads kept without times.
 *  Only published heads of chains the kept heads name are compared; times a published head carries are ignored. Never
 *  throws. */
export function checkChainHeads(kept: readonly KeptChainHead[], published: readonly SignedChainHead[] = []): HeadsCheck {
  try { return compareHeads(kept, published); }
  catch (error) { return { ok: false, problems: [`the chain heads could not be compared (${(error as Error)?.message ?? String(error)})`], chains: 0, matched: 0 }; }
}

function compareHeads(kept: readonly KeptChainHead[], published: readonly SignedChainHead[]): HeadsCheck {
  const problems: string[] = [];
  const chains = new Map<string, Sourced[]>();
  for (const h of kept) {
    if (!isSignedChainHead(h)) { problems.push("a kept head is malformed"); continue; }
    chains.set(h.head.anchor_id, [...(chains.get(h.head.anchor_id) ?? []), { head: h.head, from: "kept", sentAt: localTime(h, "sent_at"), heldBy: localTime(h, "received_at"), clock: localClock(h) }]);
  }
  let matched = 0;
  for (const h of published) {
    if (!isSignedChainHead(h) || !chains.has(h.head.anchor_id)) continue;
    matched += 1;
    chains.get(h.head.anchor_id)!.push({ head: h.head, from: "published", sentAt: NaN, heldBy: NaN, clock: null });
  }
  for (const [id, list] of chains) {
    const reported = new Set<Sourced>();
    const ordered = [...list].sort((a, b) => Date.parse(a.head.issued_at) - Date.parse(b.head.issued_at) || a.head.ingest_seq - b.head.ingest_seq);
    for (let i = 1; i < ordered.length; i++) {
      const a = ordered[i - 1], b = ordered[i];
      if (b.head.ingest_seq < a.head.ingest_seq) {
        reported.add(b);
        problems.push(`chain ${short(id)} went back: sequence ${a.head.ingest_seq} (${a.from}, ${a.head.issued_at}) then ${b.head.ingest_seq} (${b.from}, ${b.head.issued_at})`);
      }
    }
    // This computer's order: the highest head already held when each later delivery was sent, on the same clock. A head held
    // before its own delivery was sent was timed across a clock step back: its sent time is on a clock that has gone back.
    for (const b of list) {
      if (b.from !== "kept" || !Number.isFinite(b.sentAt) || reported.has(b) || b.heldBy < b.sentAt) continue;
      let before: Sourced | null = null;
      for (const a of list) {
        if (a.from !== "kept" || !Number.isFinite(a.heldBy) || a.heldBy > b.sentAt || a.head.ingest_seq <= b.head.ingest_seq) continue;
        if (a.clock !== null && b.clock !== null && a.clock !== b.clock) continue;
        if (!before || a.head.ingest_seq > before.head.ingest_seq) before = a;
      }
      if (before) {
        problems.push(`chain ${short(id)} went back: sequence ${before.head.ingest_seq} (kept, issued ${before.head.issued_at}, held here by ${new Date(before.heldBy).toISOString()}) then ${b.head.ingest_seq} (kept, issued ${b.head.issued_at}, answering a delivery sent after that, at ${new Date(b.sentAt).toISOString()})`);
      }
    }
    const ends = new Map<number, { digest: string; from: string }>();
    for (const { head, from } of ordered) {
      if (!head.segment) continue;
      const prior = ends.get(head.segment.last_ingest_seq);
      if (prior && prior.digest !== head.segment.digest) {
        problems.push(`chain ${short(id)}: two different segments end at sequence ${head.segment.last_ingest_seq} (${short(prior.digest)}, ${prior.from}; ${short(head.segment.digest)}, ${from})`);
      } else if (!prior) ends.set(head.segment.last_ingest_seq, { digest: head.segment.digest, from });
    }
  }
  return { ok: problems.length === 0, problems, chains: chains.size, matched };
}

interface SegmentDoc {
  type?: unknown;
  bounds?: { first_ingest_seq?: unknown; last_ingest_seq?: unknown };
  previous_segment_digest?: unknown;
  records?: Array<{ ingest_seq?: unknown; event_id?: unknown; leaf?: unknown; receipt?: { payload?: Record<string, unknown> } }>;
  proof?: { merkle_root?: unknown };
}

export interface SegmentChainCheck {
  ok: boolean;
  problems: string[];
  segments: number;
  records: number;
  /** Per chain (anchor id): the last sequence number its newest head's segment chain covers. */
  covered: Record<string, number>;
  /** With `publicKey`: records naming that key whose signature was checked, and records of other computers (not checked). */
  signatures: { checked: number; other_keys: number };
}

/** Check downloaded evidence segments (each the decompressed canonical JSON, as served) and, against them, the heads:
 *  every segment on its own (digest, canonical form, leaves, Merkle root, consecutive sequence numbers; with `publicKey`,
 *  the signature of every record and summary that names that key; an environment's other computers sign theirs with their
 *  own keys, and those are counted, not checked), then per chain the links from its newest head's segment back to the first,
 *  consecutive across segments, and every other head of that chain naming a segment on that path with the same last
 *  sequence number. Never throws: segments it cannot check do not pass. */
export async function verifySegmentChain(
  segmentTexts: readonly string[], heads: readonly SignedChainHead[] = [], options: { publicKey?: string | JsonWebKey } = {},
): Promise<SegmentChainCheck> {
  try { return await checkSegmentChain(segmentTexts, heads, options); }
  catch (error) {
    return { ok: false, problems: [`the segments could not be checked (${(error as Error)?.message ?? String(error)})`], segments: 0, records: 0, covered: {}, signatures: { checked: 0, other_keys: 0 } };
  }
}

async function checkSegmentChain(
  segmentTexts: readonly string[], heads: readonly SignedChainHead[], options: { publicKey?: string | JsonWebKey },
): Promise<SegmentChainCheck> {
  const problems: string[] = [];
  const docs = new Map<string, SegmentDoc>();
  let records = 0;
  const signatures = { checked: 0, other_keys: 0 };
  let kid: string | null = null;
  if (options.publicKey) {
    try { kid = await deriveKeyId((await importEd25519PublicKey(options.publicKey)).jwk); }
    catch { problems.push("the public key given is not an Ed25519 key"); }
  }
  for (const [i, text] of segmentTexts.entries()) {
    let doc: SegmentDoc;
    try { doc = JSON.parse(text) as SegmentDoc; } catch { problems.push(`segment ${i} is not JSON`); continue; }
    const digest = await sha256Hex(text);
    const name = short(digest);
    if (doc?.type !== SEGMENT_TYPE || !Array.isArray(doc.records) || !isObj(doc.bounds)) { problems.push(`segment ${name} is not an evidence segment`); continue; }
    try { if (canonical(doc) !== text) problems.push(`segment ${name} is not in canonical form`); } catch { problems.push(`segment ${name} is not in canonical form`); }
    const leaves: string[] = [];
    let expected = doc.bounds.first_ingest_seq;
    for (const [position, r] of doc.records.entries()) {
      records += 1;
      if (!isObj(r)) {
        // It still takes its place: the records after it keep their expected sequence numbers, and its leaf is empty.
        problems.push(`segment ${name}: the record at position ${position} is not an object`);
        expected = typeof expected === "number" ? expected + 1 : expected;
        leaves.push("");
        continue;
      }
      if (r.ingest_seq !== expected) problems.push(`segment ${name}: sequence ${String(r.ingest_seq)} where ${String(expected)} was expected`);
      expected = typeof r.ingest_seq === "number" ? r.ingest_seq + 1 : expected;
      const leaf = typeof r.leaf === "string" ? r.leaf : "";
      leaves.push(leaf);
      try { if (!r.receipt?.payload || (await sha256Hex(canonical(r.receipt.payload))) !== leaf) problems.push(`segment ${name}: record ${String(r.event_id)} does not hash to its leaf`); }
      catch { problems.push(`segment ${name}: record ${String(r.event_id)} cannot be hashed`); }
      if (kid && options.publicKey && r.receipt?.payload) {
        const named = (r.receipt.payload.attester as { kid?: unknown } | undefined)?.kid;
        if (named !== kid) signatures.other_keys += 1;
        else {
          signatures.checked += 1;
          const check = r.receipt.payload.type === SUMMARY_TYPE ? await verifySummarySignature(r.receipt, options.publicKey) : await verifyReceiptSignature(r.receipt, options.publicKey);
          if (!check.valid) problems.push(`segment ${name}: record ${String(r.event_id)} names this key but its signature does not verify`);
        }
      }
    }
    if (doc.bounds.last_ingest_seq !== (typeof expected === "number" ? expected - 1 : undefined)) problems.push(`segment ${name}: its bounds do not match its records`);
    if ((await merkleRootV1(leaves)) !== doc.proof?.merkle_root) problems.push(`segment ${name}: the Merkle root does not match its leaves`);
    docs.set(digest, doc);
  }
  const byChain = new Map<string, ChainHead[]>();
  for (const h of heads) {
    if (!isSignedChainHead(h)) { problems.push("a head is malformed"); continue; }
    byChain.set(h.head.anchor_id, [...(byChain.get(h.head.anchor_id) ?? []), h.head]);
  }
  const covered: Record<string, number> = {};
  for (const [id, list] of byChain) {
    const ordered = [...list].sort((a, b) => Date.parse(a.issued_at) - Date.parse(b.issued_at));
    const newest = [...ordered].reverse().find((h) => h.segment);
    if (!newest?.segment) continue;
    // The path from the newest head's segment back to the first segment.
    const path = new Map<string, number>();
    let digest: string | null = newest.segment.digest;
    let next: SegmentDoc | null = null;
    for (let guard = 0; digest !== null && guard < 1_000_000; guard++) {
      const doc = docs.get(digest);
      if (!doc) { problems.push(`chain ${short(id)}: segment ${short(digest)} is not among the segments given`); break; }
      const last = Number(doc.bounds?.last_ingest_seq);
      if (path.has(digest)) { problems.push(`chain ${short(id)}: the segment links loop at ${short(digest)}`); break; }
      path.set(digest, last);
      if (next && Number(next.bounds?.first_ingest_seq) !== last + 1) problems.push(`chain ${short(id)}: sequence numbers ${last + 1}–${Number(next.bounds?.first_ingest_seq) - 1} are in no segment`);
      next = doc;
      digest = typeof doc.previous_segment_digest === "string" ? doc.previous_segment_digest : null;
    }
    covered[id] = newest.segment.last_ingest_seq;
    for (const h of ordered) {
      if (!h.segment) continue;
      const end = path.get(h.segment.digest);
      if (end === undefined) problems.push(`chain ${short(id)}: the head issued ${h.issued_at} names segment ${short(h.segment.digest)}, which is no longer in the chain`);
      else if (end !== h.segment.last_ingest_seq) problems.push(`chain ${short(id)}: segment ${short(h.segment.digest)} ends at ${end}, not ${h.segment.last_ingest_seq} as its head says`);
    }
  }
  return { ok: problems.length === 0, problems, segments: docs.size, records, covered, signatures };
}
