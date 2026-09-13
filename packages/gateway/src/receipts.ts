// Receipts: the scopebond:receipt envelope, Ed25519 countersigning, and the
// ReceiptStore interface with an in-memory implementation (D40: an interface with
// a local implementation; SQLite/D1 are edge implementations added later).

import {
  createHash, generateKeyPairSync, sign as edSign, verify as edVerify,
  createPrivateKey, createPublicKey,
} from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { Intent, Receipt } from "@scopebond/verify";

export function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export const intentHash = (intent: Intent): string => sha256(canonical(intent));

export type RealtimeResult = "allow" | "deny" | "approved" | "timeout";

export interface ReceiptPayload {
  type: "scopebond:receipt";
  intent: Intent;
  intent_hash: string;
  policy_hash: string;
  policy_version: number;
  verifier_version: string;
  realtime_result: RealtimeResult;
  executed: boolean;
  execution_ref: string | null;
  attester: { kind: "gateway"; kid: string };
  timestamp: string;
}

export interface SignedReceipt {
  payload: ReceiptPayload;
  signature: { alg: "Ed25519"; sig: string };
}

export interface Attester {
  kind: "gateway";
  kid: string;
  publicKeyPem: string;
  /** The public key as a JWK (OKP/Ed25519) with kid — for JWKS discovery. */
  publicKeyJwk: Record<string, unknown>;
  /** Sign the canonical payload. May be async (WebCrypto attesters on the edge). */
  sign(canonicalPayload: string): string | Promise<string>;
}

/** A stable key id derived from the public key, so a receipt names the key that
 *  signed it and verifiers can resolve it across restarts. */
function fingerprintKid(jwk: Record<string, unknown>): string {
  return "key:" + sha256(canonical(jwk)).slice(0, 16);
}

function attesterFromKeyObjects(publicKey: KeyObject, privateKey: KeyObject, kid?: string): Attester {
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  const finalKid = kid ?? fingerprintKid(jwk);
  return {
    kind: "gateway",
    kid: finalKid,
    publicKeyPem,
    publicKeyJwk: { ...jwk, kid: finalKid, alg: "EdDSA", use: "sig" },
    sign: (canon) => edSign(null, Buffer.from(canon), privateKey).toString("base64"),
  };
}

/** Create a gateway attester with a fresh Ed25519 key (ephemeral — for tests and
 *  in-process use). For a durable, verifiable attester, persist the key: see
 *  `attesterFromPrivateKeyPem` and `loadOrCreateAttester` (@scopebond/gateway/node). */
export function createAttester(kid = "gateway-local"): Attester {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return attesterFromKeyObjects(publicKey, privateKey, kid);
}

/** Build an attester from a persisted Ed25519 private key (PKCS8 PEM). The kid,
 *  if not given, is derived from the public key so it is stable across restarts. */
export function attesterFromPrivateKeyPem(pem: string, kid?: string): Attester {
  const privateKey = createPrivateKey(pem);
  const publicKey = createPublicKey(privateKey);
  return attesterFromKeyObjects(publicKey, privateKey, kid);
}

export interface ReceiptVerification {
  valid: boolean;
  signature_valid: boolean;
  intent_hash_valid: boolean;
}

/** Independently verify a scopebond:receipt against an attester public key (SPKI
 *  PEM): the Ed25519 signature covers the canonical payload, and the recorded
 *  intent_hash matches the intent. This is what a receipt holder runs to trust it. */
export function verifyReceipt(receipt: SignedReceipt, publicKeyPem: string): ReceiptVerification {
  if (!receipt?.payload || !receipt?.signature?.sig) {
    return { valid: false, signature_valid: false, intent_hash_valid: false };
  }
  let signature_valid = false;
  try {
    const key = createPublicKey(publicKeyPem);
    signature_valid = edVerify(
      null,
      Buffer.from(canonical(receipt.payload)),
      key,
      Buffer.from(receipt.signature.sig, "base64"),
    );
  } catch {
    signature_valid = false;
  }
  const intent_hash_valid = receipt.payload.intent_hash === intentHash(receipt.payload.intent);
  return { valid: signature_valid && intent_hash_valid, signature_valid, intent_hash_valid };
}

export async function buildReceipt(payloadFields: Omit<ReceiptPayload, "type">, attester: Attester): Promise<SignedReceipt> {
  const payload: ReceiptPayload = { type: "scopebond:receipt", ...payloadFields };
  const sig = await attester.sign(canonical(payload));
  return { payload, signature: { alg: "Ed25519", sig } };
}

/** The fixed 12-byte SPKI DER prefix for an Ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const b64urlToBuf = (s: string): Buffer => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** Wrap a raw 32-byte Ed25519 public key (as JWK `x`, base64url) into an SPKI PEM
 *  — so a WebCrypto-derived key produces the same PEM as node:crypto exports. */
export function ed25519JwkToSpkiPem(x: string): string {
  const der = Buffer.concat([ED25519_SPKI_PREFIX, b64urlToBuf(x)]);
  const b64 = der.toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`;
}

/** Public: derive the stable, key-fingerprint kid from a public JWK. */
export function deriveKid(publicJwk: Record<string, unknown>): string {
  return fingerprintKid(publicJwk);
}

/** A tamper-evidence anchor: a Merkle root committing to the first `count`
 *  receipts (append-only order), chained to the previous anchor. */
export interface Anchor {
  seq: number;
  algo: "sha256-merkle";
  merkle_root: string;
  count: number;
  from: string | null;
  to: string;
  prev_anchor_hash: string | null;
  anchor_hash: string;
  timestamp: string;
}

export interface ReceiptStore {
  put(r: SignedReceipt): void | Promise<void>;
  list(): SignedReceipt[] | Promise<SignedReceipt[]>;
  /** The receipt payloads, for feeding claim-time-style evaluation to verify. */
  executed(): Receipt[] | Promise<Receipt[]>;
  /** Release any underlying handle (e.g. a SQLite connection). Optional. */
  close?(): void | Promise<void>;
  /** Append an anchor. Optional — a store that supports anchoring implements both. */
  putAnchor?(a: Anchor): void | Promise<void>;
  anchors?(): Anchor[] | Promise<Anchor[]>;
}

export class MemoryReceiptStore implements ReceiptStore {
  private all: SignedReceipt[] = [];
  private anchorLog: Anchor[] = [];
  put(r: SignedReceipt): void { this.all.push(r); }
  list(): SignedReceipt[] { return this.all.slice(); }
  executed(): Receipt[] { return this.all.map((r) => r.payload as unknown as Receipt); }
  putAnchor(a: Anchor): void { this.anchorLog.push(a); }
  anchors(): Anchor[] { return this.anchorLog.slice(); }
}
