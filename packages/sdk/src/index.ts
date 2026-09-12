// @scopebond/sdk — operator-side signing of agent action intents (Ed25519) and a
// thin client for submitting them to a Scopebond gateway. Zero dependencies
// (node:crypto + global fetch).

import { generateKeyPairSync, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, createHash } from "node:crypto";

export interface Intent {
  action_type: string;
  asset?: string;
  amount?: number;
  signer?: string;
  params?: Record<string, unknown>;
}

export interface SignedIntent {
  intent: Intent;
  signer: string;
  alg: "Ed25519";
  signature: string;
  approval?: unknown;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

export interface Signer {
  /** Agent key id (used for key_policy clauses); set as intent.signer. */
  kid: string;
  publicKeyPem: string;
  sign(intent: Intent): SignedIntent;
}

/** Create an agent signer. Generates a fresh Ed25519 key, or loads one from PEM. */
export function createSigner(opts: { privateKeyPem?: string; kid?: string } = {}): Signer {
  const priv = opts.privateKeyPem ? createPrivateKey(opts.privateKeyPem) : generateKeyPairSync("ed25519").privateKey;
  const pub = createPublicKey(priv);
  const publicKeyPem = pub.export({ type: "spki", format: "pem" }).toString();
  const kid = opts.kid ?? "key:" + createHash("sha256").update(publicKeyPem).digest("hex").slice(0, 16);
  return {
    kid,
    publicKeyPem,
    sign(intent: Intent): SignedIntent {
      const withSigner: Intent = { ...intent, signer: intent.signer ?? kid };
      const signature = edSign(null, Buffer.from(canonical(withSigner)), priv).toString("base64");
      return { intent: withSigner, signer: kid, alg: "Ed25519", signature };
    },
  };
}

/** Verify a signed intent against a public key (PEM). */
export function verifyIntentSignature(signed: SignedIntent, publicKeyPem: string): boolean {
  try {
    return edVerify(null, Buffer.from(canonical(signed.intent)), createPublicKey(publicKeyPem), Buffer.from(signed.signature, "base64"));
  } catch { return false; }
}

export interface SubmitResult { allowed: boolean; reason: string; receipt: unknown; }

/** Submit a signed intent to a gateway's /v1/evaluate. `fetchImpl` is injectable. */
export async function submit(
  gatewayUrl: string, signed: SignedIntent, fetchImpl: typeof fetch = fetch,
): Promise<SubmitResult> {
  const res = await fetchImpl(gatewayUrl.replace(/\/$/, "") + "/v1/evaluate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent: signed.intent, approval: signed.approval }),
  });
  return res.json() as Promise<SubmitResult>;
}
