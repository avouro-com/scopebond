// Cloudflare Workers building blocks: a KV-backed ReceiptStore and helpers that
// bootstrap a persistent WebCrypto attester in KV, so a Worker gateway keeps a
// stable signing key and a durable receipt log without any node: dependency.
// (In production, a D1-backed store is the queryable option; KV suits the demo.)

import { createGateway } from "./app.js";
import type { Gateway } from "./app.js";
import { createWebCryptoAttester, generateAttesterJwk } from "./webcrypto.js";
import type { ReceiptStore, SignedReceipt, Attester } from "./receipts.js";
import type { Receipt, Policy } from "@scopebond/verify";

/** The subset of Cloudflare's KVNamespace this package uses. */
export interface KvLike {
  get(key: string, type?: "text"): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

/** Receipts as a single JSON array in KV — simple and durable for light/demo use
 *  (capped to the most recent `cap`). For high volume, use a D1-backed store. */
export class KvReceiptStore implements ReceiptStore {
  constructor(private readonly kv: KvLike, private readonly key = "receipts", private readonly cap = 500) {}
  private async load(): Promise<SignedReceipt[]> {
    const raw = await this.kv.get(this.key, "text");
    return raw ? (JSON.parse(raw) as SignedReceipt[]) : [];
  }
  async put(r: SignedReceipt): Promise<void> {
    const all = await this.load();
    all.push(r);
    await this.kv.put(this.key, JSON.stringify(all.slice(-this.cap)));
  }
  async list(): Promise<SignedReceipt[]> { return this.load(); }
  async executed(): Promise<Receipt[]> { return (await this.load()).map((r) => r.payload as unknown as Receipt); }
}

/** Load the attester key from KV, or generate + persist one. Returns a WebCrypto
 *  attester with a stable kid — so receipts stay verifiable across requests. */
export async function loadOrCreateKvAttester(kv: KvLike, key = "attester:jwk"): Promise<Attester> {
  let raw = await kv.get(key, "text");
  if (!raw) {
    raw = JSON.stringify(await generateAttesterJwk());
    await kv.put(key, raw);
  }
  return createWebCryptoAttester(JSON.parse(raw));
}

/** Build a gateway for a Worker: a persistent KV attester + KV receipt store. */
export async function createWorkerGateway(opts: { policy: Policy; kv: KvLike; attesterKey?: string }): Promise<Gateway> {
  const attester = await loadOrCreateKvAttester(opts.kv, opts.attesterKey);
  return createGateway({ policy: opts.policy, attester, store: new KvReceiptStore(opts.kv) });
}
