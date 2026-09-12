// Receipts: the scopebond:receipt envelope, Ed25519 countersigning, and the
// ReceiptStore interface with an in-memory implementation (D40: an interface with
// a local implementation; SQLite/D1 are edge implementations added later).

import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
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
  sign(canonicalPayload: string): string;
}

/** Create a gateway attester with a fresh Ed25519 key (alpha: ephemeral in memory). */
export function createAttester(kid = "gateway-local"): Attester {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    kind: "gateway",
    kid,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    sign: (canon) => edSign(null, Buffer.from(canon), privateKey).toString("base64"),
  };
}

export function buildReceipt(payloadFields: Omit<ReceiptPayload, "type">, attester: Attester): SignedReceipt {
  const payload: ReceiptPayload = { type: "scopebond:receipt", ...payloadFields };
  const sig = attester.sign(canonical(payload));
  return { payload, signature: { alg: "Ed25519", sig } };
}

export interface ReceiptStore {
  put(r: SignedReceipt): void | Promise<void>;
  list(): SignedReceipt[] | Promise<SignedReceipt[]>;
  /** The receipt payloads, for feeding claim-time-style evaluation to verify. */
  executed(): Receipt[] | Promise<Receipt[]>;
}

export class MemoryReceiptStore implements ReceiptStore {
  private all: SignedReceipt[] = [];
  put(r: SignedReceipt): void { this.all.push(r); }
  list(): SignedReceipt[] { return this.all.slice(); }
  executed(): Receipt[] { return this.all.map((r) => r.payload as unknown as Receipt); }
}
