// Anchor verification for the Scopebond receipt log (SPEC.md, "Anchors").
//
// Two anchor algorithms exist and verifiers dispatch on `algo`:
//
//   - "sha256-merkle" (v1, legacy): hex-string Merkle tree without leaf/node
//     domain separation that duplicates the odd node, and an unsigned anchor.
//     Kept only so existing anchors keep verifying.
//   - "rfc9162-sha256" (v2): the RFC 9162 §2.1 Merkle Tree Hash over SHA-256 with
//     inclusion (audit path) and consistency proofs, and an Ed25519-signed anchor.
//
// Pure and runtime-agnostic: WebCrypto (globalThis.crypto.subtle) only, no node:
// imports, so the same bytes verify in Node, browsers and edge runtimes. Every
// function is async because WebCrypto digests are async. Hashes are exchanged as
// lowercase hex strings of 32-byte SHA-256 digests.

import { canonical } from "@scopebond/policy-schema/canonical";

export const ANCHOR_ALGO_V1 = "sha256-merkle" as const;
export const ANCHOR_ALGO_V2 = "rfc9162-sha256" as const;
export const ANCHOR_TYPE = "scopebond:anchor" as const;

/** A legacy (v1) anchor. `algo` may be absent on the very oldest records. */
export interface AnchorV1 {
  seq: number;
  algo?: typeof ANCHOR_ALGO_V1;
  merkle_root: string;
  count: number;
  from: string | null;
  to: string;
  prev_anchor_hash: string | null;
  anchor_hash: string;
  timestamp: string;
}

/** The signed fields of a v2 anchor (everything except `anchor_hash` and `signature`). */
export interface AnchorV2Body {
  type: typeof ANCHOR_TYPE;
  seq: number;
  algo: typeof ANCHOR_ALGO_V2;
  tree_size: number;
  root: string;
  prev_anchor_hash: string | null;
  timestamp: string;
  attester: { kind: "gateway"; kid: string };
}

/** A v2 anchor: RFC 9162 root over the first `tree_size` receipts, Ed25519-signed. */
export interface AnchorV2 extends AnchorV2Body {
  /** hex SHA-256 over the UTF-8 bytes of canonical(body). */
  anchor_hash: string;
  /** Ed25519 over the same UTF-8 bytes of canonical(body), standard base64. */
  signature: { alg: "Ed25519"; sig: string };
}

export type AnyAnchor = AnchorV1 | AnchorV2;

/** An RFC 9162 inclusion proof for one leaf in a tree of `tree_size` leaves. */
export interface InclusionProof {
  leaf_index: number;
  tree_size: number;
  /** Sibling hashes, leaf level first (RFC 9162 §2.1.3.1 PATH). */
  audit_path: string[];
}

/** An RFC 9162 consistency proof between two tree sizes. */
export interface ConsistencyProof {
  first_size: number;
  second_size: number;
  /** RFC 9162 §2.1.4.1 PROOF(first_size, D[second_size]). */
  proof: string[];
}

export interface Ed25519PublicJwk { kty: string; crv: string; x: string; [k: string]: unknown }

// ---------------------------------------------------------------------------
// Byte helpers

const HEX32 = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto (globalThis.crypto.subtle) is required");
  return s;
}

async function digest(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest("SHA-256", bytes as BufferSource));
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function fromHex(hex: string): Uint8Array {
  if (typeof hex !== "string" || !HEX32.test(hex)) throw new TypeError("expected a 32-byte lowercase hex digest");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const isHex32 = (v: unknown): v is string => typeof v === "string" && HEX32.test(v);
const isSize = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** hex SHA-256 of a UTF-8 string or raw bytes. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  return toHex(await digest(typeof data === "string" ? encoder.encode(data) : data));
}

// ---------------------------------------------------------------------------
// v1 (legacy) — reproduced exactly so old anchors keep verifying.

/** v1 leaf: hex SHA-256 of the UTF-8 canonical (RFC 8785) receipt payload. */
export async function receiptLeafHashV1(payload: unknown): Promise<string> {
  return sha256Hex(canonical(payload));
}

/** v1 root: node = hex SHA-256 of the UTF-8 *hex strings* concatenated; an odd
 *  node is paired with itself; an empty set commits to SHA-256(""). Identical to
 *  `merkleRoot` in @scopebond/gateway. Legacy only — see SPEC.md for its weaknesses. */
export async function merkleRootV1(leaves: string[]): Promise<string> {
  if (leaves.length === 0) return sha256Hex("");
  let level = leaves.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(await sha256Hex(a + b));
    }
    level = next;
  }
  return level[0];
}

// ---------------------------------------------------------------------------
// v2 — RFC 9162 §2.1

const LEAF_PREFIX = new Uint8Array([0x00]);
const NODE_PREFIX = new Uint8Array([0x01]);

/** RFC 9162 leaf hash: SHA-256(0x00 ‖ leaf bytes). A string is taken as UTF-8. */
export async function leafHash(leaf: string | Uint8Array): Promise<string> {
  const bytes = typeof leaf === "string" ? encoder.encode(leaf) : leaf;
  return toHex(await digest(concat(LEAF_PREFIX, bytes)));
}

/** RFC 9162 interior node: SHA-256(0x01 ‖ left ‖ right) over raw 32-byte digests. */
export async function nodeHash(left: string, right: string): Promise<string> {
  return toHex(await nodeBytes(fromHex(left), fromHex(right)));
}

const nodeBytes = (l: Uint8Array, r: Uint8Array) => digest(concat(NODE_PREFIX, l, r));

/** v2 leaf of a receipt: leafHash(UTF-8 canonical(payload)) — the same leaf input as v1. */
export async function receiptLeafHash(payload: unknown): Promise<string> {
  return leafHash(canonical(payload));
}

/** Largest power of two strictly smaller than n (n > 1). */
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

async function mth(d: Uint8Array[], lo: number, hi: number): Promise<Uint8Array> {
  const n = hi - lo;
  if (n === 0) return digest(new Uint8Array(0));
  if (n === 1) return d[lo];
  const k = splitPoint(n);
  return nodeBytes(await mth(d, lo, lo + k), await mth(d, lo + k, hi));
}

function leafBytes(leafHashes: string[]): Uint8Array[] {
  if (!Array.isArray(leafHashes)) throw new TypeError("leaf hashes must be an array");
  return leafHashes.map(fromHex);
}

/** RFC 9162 Merkle Tree Hash over already-hashed leaves (see `leafHash`).
 *  The empty tree hashes to SHA-256(""). */
export async function merkleTreeHash(leafHashes: string[]): Promise<string> {
  const d = leafBytes(leafHashes);
  return toHex(await mth(d, 0, d.length));
}

async function path(m: number, d: Uint8Array[], lo: number, hi: number): Promise<Uint8Array[]> {
  const n = hi - lo;
  if (n <= 1) return [];
  const k = splitPoint(n);
  if (m < k) return [...(await path(m, d, lo, lo + k)), await mth(d, lo + k, hi)];
  return [...(await path(m - k, d, lo + k, hi)), await mth(d, lo, lo + k)];
}

/** RFC 9162 §2.1.3.1 audit path for leaf `index` in the tree over `leafHashes`. */
export async function inclusionProof(leafHashes: string[], index: number): Promise<InclusionProof> {
  const d = leafBytes(leafHashes);
  if (!Number.isSafeInteger(index) || index < 0 || index >= d.length) throw new RangeError("leaf index out of range");
  return { leaf_index: index, tree_size: d.length, audit_path: (await path(index, d, 0, d.length)).map(toHex) };
}

/** RFC 9162 §2.1.3.2: verify that `leaf_hash` is leaf `leaf_index` of the tree of
 *  `tree_size` leaves whose root is `root`. Never throws; malformed input is false. */
export async function verifyInclusionProof(input: {
  leaf_hash: string; leaf_index: number; tree_size: number; audit_path: string[]; root: string;
}): Promise<boolean> {
  const { leaf_hash, leaf_index, tree_size, audit_path, root } = input ?? ({} as never);
  if (!isHex32(leaf_hash) || !isHex32(root) || !isSize(leaf_index) || !isSize(tree_size)) return false;
  if (!Array.isArray(audit_path) || !audit_path.every(isHex32)) return false;
  if (leaf_index >= tree_size) return false;
  // Bit arithmetic on sizes beyond 2^31 would overflow JS int32 ops; use division.
  let fn = leaf_index;
  let sn = tree_size - 1;
  let r = fromHex(leaf_hash);
  for (const p of audit_path) {
    if (sn === 0) return false;
    const sib = fromHex(p);
    if (fn % 2 === 1 || fn === sn) {
      r = await nodeBytes(sib, r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
      }
    } else {
      r = await nodeBytes(r, sib);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && toHex(r) === root;
}

async function subproof(m: number, d: Uint8Array[], lo: number, hi: number, b: boolean): Promise<Uint8Array[]> {
  const n = hi - lo;
  if (m === n) return b ? [] : [await mth(d, lo, hi)];
  const k = splitPoint(n);
  if (m <= k) return [...(await subproof(m, d, lo, lo + k, b)), await mth(d, lo + k, hi)];
  return [...(await subproof(m - k, d, lo + k, hi, false)), await mth(d, lo, lo + k)];
}

/** RFC 9162 §2.1.4.1 consistency proof that the tree of the first `firstSize`
 *  leaves is a prefix of the tree over all `leafHashes`. */
export async function consistencyProof(leafHashes: string[], firstSize: number): Promise<ConsistencyProof> {
  const d = leafBytes(leafHashes);
  if (!Number.isSafeInteger(firstSize) || firstSize < 0 || firstSize > d.length) throw new RangeError("first size out of range");
  const proof = firstSize === 0 || firstSize === d.length ? [] : (await subproof(firstSize, d, 0, d.length, true)).map(toHex);
  return { first_size: firstSize, second_size: d.length, proof };
}

const isPowerOfTwo = (n: number) => n > 0 && Number.isInteger(Math.log2(n)) && 2 ** Math.log2(n) === n;

/** RFC 9162 §2.1.4.2: verify that the tree of `first_size` leaves with root
 *  `first_root` is a prefix of the tree of `second_size` leaves with root
 *  `second_root`. The empty tree is consistent with every tree. Never throws. */
export async function verifyConsistencyProof(input: {
  first_size: number; second_size: number; first_root: string; second_root: string; proof: string[];
}): Promise<boolean> {
  const { first_size, second_size, first_root, second_root, proof } = input ?? ({} as never);
  if (!isSize(first_size) || !isSize(second_size) || first_size > second_size) return false;
  if (!isHex32(first_root) || !isHex32(second_root)) return false;
  if (!Array.isArray(proof) || !proof.every(isHex32)) return false;
  if (first_size === 0) return proof.length === 0;
  if (first_size === second_size) return proof.length === 0 && first_root === second_root;
  const path = isPowerOfTwo(first_size) ? [first_root, ...proof] : proof.slice();
  if (path.length === 0) return false;
  let fn = first_size - 1;
  let sn = second_size - 1;
  while (fn % 2 === 1) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
  let fr = fromHex(path[0]);
  let sr = fromHex(path[0]);
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    const cb = fromHex(c);
    if (fn % 2 === 1 || fn === sn) {
      fr = await nodeBytes(cb, fr);
      sr = await nodeBytes(cb, sr);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
      }
    } else {
      sr = await nodeBytes(sr, cb);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return toHex(fr) === first_root && toHex(sr) === second_root && sn === 0;
}

// ---------------------------------------------------------------------------
// Anchors — dispatch on `algo`

export const isAnchorV2 = (a: unknown): a is AnchorV2 =>
  !!a && typeof a === "object" && (a as { algo?: unknown }).algo === ANCHOR_ALGO_V2;

/** The exact object whose canonical UTF-8 bytes are hashed (and, for v2, signed). */
export function anchorBody(anchor: AnyAnchor): Record<string, unknown> {
  const body: Record<string, unknown> = { ...(anchor as unknown as Record<string, unknown>) };
  delete body.anchor_hash;
  if (isAnchorV2(anchor)) delete body.signature;
  return body;
}

/** Recompute an anchor's hash: hex SHA-256(UTF-8 canonical(anchorBody(anchor))). */
export async function anchorHash(anchor: AnyAnchor): Promise<string> {
  return sha256Hex(canonical(anchorBody(anchor)));
}

/** The Merkle root an anchor of `algo` commits to over the given receipt payloads
 *  (in log order). v1: merkleRootV1 over receiptLeafHashV1; v2: merkleTreeHash
 *  over receiptLeafHash. */
export async function anchorRoot(algo: string | undefined, payloads: unknown[]): Promise<string> {
  if (algo === ANCHOR_ALGO_V2) return merkleTreeHash(await Promise.all(payloads.map(receiptLeafHash)));
  if (algo === undefined || algo === ANCHOR_ALGO_V1) return merkleRootV1(await Promise.all(payloads.map(receiptLeafHashV1)));
  throw new Error(`unsupported anchor algo: ${String(algo)}`);
}

/** Does the anchor commit to exactly these receipt payloads (the first count/tree_size of the log)? */
export async function verifyAnchorRoot(anchor: AnyAnchor, payloads: unknown[]): Promise<boolean> {
  try {
    if (isAnchorV2(anchor)) {
      return payloads.length === anchor.tree_size && (await anchorRoot(anchor.algo, payloads)) === anchor.root;
    }
    const a = anchor as AnchorV1;
    return payloads.length === a.count && (await anchorRoot(a.algo, payloads)) === a.merkle_root;
  } catch { return false; }
}

/** The stable key id for an Ed25519 public JWK (same derivation as receipts' attester kid). */
export async function deriveKid(jwk: Ed25519PublicJwk): Promise<string> {
  return "key:" + (await sha256Hex(canonical({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))).slice(0, 16);
}

/** Verify a v2 anchor: its `anchor_hash`, that `attester.kid` names `publicJwk`,
 *  and the Ed25519 signature over UTF-8 canonical(body). v1 anchors are unsigned,
 *  so this returns false for them. Never throws. */
export async function verifyAnchorSignature(anchor: AnyAnchor, publicJwk: Ed25519PublicJwk): Promise<boolean> {
  try {
    if (!isAnchorV2(anchor)) return false;
    if (anchor.type !== ANCHOR_TYPE || !isSize(anchor.tree_size) || !isHex32(anchor.root)) return false;
    if (anchor.signature?.alg !== "Ed25519" || typeof anchor.signature.sig !== "string") return false;
    if (publicJwk?.kty !== "OKP" || publicJwk.crv !== "Ed25519" || typeof publicJwk.x !== "string") return false;
    if (anchor.attester?.kid !== (await deriveKid(publicJwk))) return false;
    const bytes = encoder.encode(canonical(anchorBody(anchor)));
    if (toHex(await digest(bytes)) !== anchor.anchor_hash) return false;
    const key = await subtle().importKey(
      "jwk", { kty: "OKP", crv: "Ed25519", x: publicJwk.x } as JsonWebKey, { name: "Ed25519" }, false, ["verify"],
    );
    return await subtle().verify({ name: "Ed25519" }, key, base64ToBytes(anchor.signature.sig) as BufferSource, bytes as BufferSource);
  } catch { return false; }
}

export interface AnchorChainResult { valid: boolean; error?: string; index?: number }

/** Verify an anchor log in order: sequence numbers, `anchor_hash` recomputation,
 *  `prev_anchor_hash` links (v1 → v2 included), non-decreasing sizes, and every v2
 *  signature (a v2 anchor never passes without `publicJwk`). Once a v2 anchor appears, a later v1 anchor
 *  is rejected (no downgrade). Root/receipt agreement and consistency proofs are
 *  checked separately (verifyAnchorRoot, verifyConsistencyProof). */
export async function verifyAnchorChain(anchors: AnyAnchor[], publicJwk?: Ed25519PublicJwk): Promise<AnchorChainResult> {
  if (!Array.isArray(anchors)) return { valid: false, error: "anchors must be an array" };
  let prev: AnyAnchor | null = null;
  let seenV2 = false;
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const fail = (error: string): AnchorChainResult => ({ valid: false, error, index: i });
    if (!a || typeof a !== "object" || !isSize(a.seq) || typeof a.anchor_hash !== "string") return fail("malformed anchor");
    const v2 = isAnchorV2(a);
    if (!v2 && a?.algo !== undefined && a?.algo !== ANCHOR_ALGO_V1) return fail("unsupported algo");
    if (seenV2 && !v2) return fail("v1 anchor after a v2 anchor (downgrade)");
    seenV2 ||= v2;
    if (a.seq !== (prev ? prev.seq + 1 : a.seq)) return fail("sequence gap");
    let h: string;
    try { h = await anchorHash(a); } catch { return fail("anchor is not canonicalizable"); }
    if (h !== a.anchor_hash) return fail("anchor_hash mismatch");
    if (a.prev_anchor_hash !== (prev ? prev.anchor_hash : a.prev_anchor_hash)) return fail("prev_anchor_hash does not link");
    if (i === 0 && prev === null && a.seq === 1 && a.prev_anchor_hash !== null) return fail("first anchor must have prev_anchor_hash null");
    const size = v2 ? (a as AnchorV2).tree_size : (a as AnchorV1).count;
    if (prev) {
      const prevSize = isAnchorV2(prev) ? prev.tree_size : (prev as AnchorV1).count;
      if (size < prevSize) return fail("log shrank");
    }
    if (v2 && !(publicJwk && (await verifyAnchorSignature(a, publicJwk)))) return fail("bad or unverifiable v2 signature");
    prev = a;
  }
  return { valid: true };
}
