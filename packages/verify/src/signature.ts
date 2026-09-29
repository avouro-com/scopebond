// Receipt signature verification with WebCrypto only — no `node:` imports, so the same
// code runs in Node (>= 20), browsers, Cloudflare Workers and Deno. Offline and
// deterministic: canonicalize the payload (RFC 8785), verify the Ed25519 signature over
// those bytes with the attester's public key, and check that the key is the one the
// payload names (`attester.kid`).
//
// Scope, matching SPEC.md: the v1 verifier accepts `signature.alg = "Ed25519"` from an
// attester of kind `gateway`. The schema reserves other algorithms and attester kinds;
// a receipt that uses one is reported as unsupported, never as valid.

import { canonical } from "@scopebond/policy-schema/canonical";

export const SUPPORTED_SIGNATURE_ALGS = ["Ed25519"] as const;
export const SUPPORTED_ATTESTER_KINDS = ["gateway"] as const;

export interface SignatureVerification {
  /** Every check below passed. */
  valid: boolean;
  /** The signature verifies over the canonical payload with the given key. */
  signature_valid: boolean;
  /** The key's derived kid equals `payload.attester.kid`. */
  key_binding_valid: boolean;
  /** `signature.alg` is one this verifier implements. */
  alg_supported: boolean;
  /** `payload.attester.kind` is one this verifier implements. */
  attester_kind_supported: boolean;
}

type Receiptish = { payload?: unknown; signature?: { alg?: unknown; sig?: unknown } };

const subtle = (): SubtleCrypto => {
  const s = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!s) throw new Error("WebCrypto (crypto.subtle) is not available in this runtime");
  return s;
};

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64UrlToBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await subtle().digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The kid Scopebond derives from an Ed25519 public key: `key:` + the first 16 hex of
 *  SHA-256 over the canonical `{crv, kty, x}` JWK members. */
export async function deriveKeyId(jwk: { crv?: string; kty?: string; x?: string }): Promise<string> {
  return "key:" + (await sha256Hex(canonical({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))).slice(0, 16);
}

/** Import an Ed25519 public key given as SPKI PEM or as a JWK. */
export async function importEd25519PublicKey(key: string | JsonWebKey): Promise<{ key: CryptoKey; jwk: JsonWebKey }> {
  if (typeof key === "string") {
    const body = key.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----/g, "");
    const der = base64ToBytes(body);
    const imported = await subtle().importKey("spki", der, { name: "Ed25519" }, true, ["verify"]);
    return { key: imported, jwk: await subtle().exportKey("jwk", imported) };
  }
  if (key.kty !== "OKP" || key.crv !== "Ed25519" || typeof key.x !== "string" || base64UrlToBytes(key.x).length !== 32) {
    throw new Error("not an Ed25519 public JWK");
  }
  const jwk: JsonWebKey = { kty: "OKP", crv: "Ed25519", x: key.x };
  return { key: await subtle().importKey("jwk", jwk, { name: "Ed25519" }, true, ["verify"]), jwk };
}

/** Verify a receipt's attester signature. Never throws for a malformed receipt or key:
 *  anything that cannot be checked is reported as not valid. */
export async function verifyReceiptSignature(receipt: unknown, publicKey: string | JsonWebKey): Promise<SignatureVerification> {
  const result: SignatureVerification = {
    valid: false, signature_valid: false, key_binding_valid: false, alg_supported: false, attester_kind_supported: false,
  };
  const r = receipt as Receiptish;
  if (!r || typeof r !== "object" || !r.payload || typeof r.payload !== "object" || !r.signature || typeof r.signature.sig !== "string") return result;
  const payload = r.payload as { attester?: { kind?: unknown; kid?: unknown } };
  result.alg_supported = (SUPPORTED_SIGNATURE_ALGS as readonly unknown[]).includes(r.signature.alg);
  result.attester_kind_supported = (SUPPORTED_ATTESTER_KINDS as readonly unknown[]).includes(payload.attester?.kind);
  if (!result.alg_supported) return result;
  try {
    const { key, jwk } = await importEd25519PublicKey(publicKey);
    const signature = base64ToBytes(r.signature.sig);
    const bytes = new TextEncoder().encode(canonical(r.payload));
    result.signature_valid = await subtle().verify({ name: "Ed25519" }, key, signature, bytes);
    result.key_binding_valid = typeof payload.attester?.kid === "string" && (await deriveKeyId(jwk)) === payload.attester.kid;
  } catch {
    return result;
  }
  result.valid = result.signature_valid && result.key_binding_valid && result.attester_kind_supported;
  return result;
}
