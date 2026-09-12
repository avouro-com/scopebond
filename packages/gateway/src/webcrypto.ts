// A WebCrypto Ed25519 attester — signs via globalThis.crypto.subtle, so the same
// gateway core runs on Cloudflare Workers and on Node. (Node uses the node:crypto
// attester in receipts.ts; the edge uses this one.) Edge-safe: no node: imports.

import { canonical, ed25519JwkToSpkiPem, deriveKid } from "./receipts.js";
import type { Attester } from "./receipts.js";

export type Ed25519Jwk = { kty: string; crv: string; x: string; d?: string };

const toBase64 = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

/** Build an attester from an Ed25519 private JWK (with `x` and `d`) using WebCrypto. */
export async function createWebCryptoAttester(privateJwk: Ed25519Jwk, kid?: string): Promise<Attester> {
  const key = await crypto.subtle.importKey("jwk", privateJwk as JsonWebKey, { name: "Ed25519" }, false, ["sign"]);
  const publicJwk: Record<string, unknown> = { kty: "OKP", crv: "Ed25519", x: privateJwk.x };
  const finalKid = kid ?? deriveKid(publicJwk);
  return {
    kind: "gateway",
    kid: finalKid,
    publicKeyPem: ed25519JwkToSpkiPem(privateJwk.x),
    publicKeyJwk: { ...publicJwk, kid: finalKid, alg: "EdDSA", use: "sig" },
    sign: async (canon: string) => {
      const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(canon));
      return toBase64(new Uint8Array(sig));
    },
  };
}

/** Generate a new Ed25519 attester key as an exportable private JWK (with `x` + `d`). */
export async function generateAttesterJwk(): Promise<Ed25519Jwk> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return (await crypto.subtle.exportKey("jwk", pair.privateKey)) as unknown as Ed25519Jwk;
}

// Keep `canonical` referenced for parity with the node attester's payload signing.
export { canonical };
