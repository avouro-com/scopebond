// @scopebond/sdk — signed, replay-resistant agent intents and approvals plus a
// thin client that preserves the complete authorization envelope.

import {
  generateKeyPairSync, createPrivateKey, createPublicKey, randomUUID,
  sign as edSign, verify as edVerify, createHash,
} from "node:crypto";

export interface Intent {
  action_type: string;
  asset?: string;
  amount?: number;
  signer?: string;
  params?: Record<string, unknown>;
}

export interface SignatureIdentity { kid: string; alg: "Ed25519" }
export interface PolicyReference { id: string | null; version: number; digest: string }

export interface SignedIntentAuthorization {
  version: "1.0";
  request_id: string;
  issued_at: string;
  expires_at: string;
  signer: SignatureIdentity;
  intent_hash: string;
  signature: string;
}

export interface SignedApproval {
  version: "1.0";
  approval_id: string;
  issued_at: string;
  expires_at: string;
  approver: SignatureIdentity;
  intent_hash: string;
  policy_ref: PolicyReference;
  decision: "approve";
  signature: string;
}

export interface SignedIntent {
  intent: Intent;
  authorization: SignedIntentAuthorization;
  approval?: SignedApproval;
}

export function canonical(v: unknown): string {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TypeError("canonical JSON rejects non-finite numbers");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    for (let index = 0; index < v.length; index += 1) if (!(index in v)) throw new TypeError("canonical JSON rejects sparse arrays");
    return "[" + v.map(canonical).join(",") + "]";
  }
  if (v && typeof v === "object") {
    const prototype = Object.getPrototypeOf(v);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("canonical JSON accepts only plain JSON objects");
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
  }
  throw new TypeError(`canonical JSON rejects ${typeof v}`);
}

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
export const intentHash = (intent: Intent): string => sha256(canonical(intent));

function deriveKidFromPublicKey(publicKeyPem: string): string {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new TypeError("signing key must be Ed25519");
  const raw = key.export({ format: "jwk" }) as Record<string, unknown>;
  return "key:" + sha256(canonical({ crv: raw.crv, kty: raw.kty, x: raw.x })).slice(0, 16);
}

export function intentAuthorizationClaims(value: SignedIntentAuthorization): Omit<SignedIntentAuthorization, "signature"> {
  return {
    version: value.version, request_id: value.request_id, issued_at: value.issued_at,
    expires_at: value.expires_at, signer: value.signer, intent_hash: value.intent_hash,
  };
}

export function approvalClaims(value: SignedApproval): Omit<SignedApproval, "signature"> {
  return {
    version: value.version, approval_id: value.approval_id, issued_at: value.issued_at,
    expires_at: value.expires_at, approver: value.approver, intent_hash: value.intent_hash,
    policy_ref: value.policy_ref, decision: value.decision,
  };
}

export interface SignOptions { requestId?: string; issuedAt?: string; expiresAt?: string; ttlMs?: number }
export interface ApprovalOptions { approvalId?: string; issuedAt?: string; expiresAt?: string; ttlMs?: number }

export interface Signer {
  kid: string;
  publicKeyPem: string;
  sign(intent: Intent, options?: SignOptions): SignedIntent;
  approve(intent: Intent, policyRef: PolicyReference, options?: ApprovalOptions): SignedApproval;
}

function period(options: { issuedAt?: string; expiresAt?: string; ttlMs?: number }): { issuedAt: string; expiresAt: string } {
  const issuedAt = options.issuedAt ?? new Date().toISOString();
  const issued = Date.parse(issuedAt);
  if (!Number.isFinite(issued)) throw new TypeError("issuedAt must be a valid timestamp");
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError("ttlMs must be positive");
  const expiresAt = options.expiresAt ?? new Date(issued + ttlMs).toISOString();
  if (!Number.isFinite(Date.parse(expiresAt))) throw new TypeError("expiresAt must be a valid timestamp");
  return { issuedAt, expiresAt };
}

/** Create an Ed25519 signer. A supplied kid is accepted only when it equals the
 * fingerprint derived from the public key, preventing identity substitution. */
export function createSigner(opts: { privateKeyPem?: string; kid?: string } = {}): Signer {
  const priv = opts.privateKeyPem ? createPrivateKey(opts.privateKeyPem) : generateKeyPairSync("ed25519").privateKey;
  const pub = createPublicKey(priv);
  const publicKeyPem = pub.export({ type: "spki", format: "pem" }).toString();
  const kid = deriveKidFromPublicKey(publicKeyPem);
  if (opts.kid && opts.kid !== kid) throw new TypeError("kid must match the signing public-key fingerprint");
  const identity: SignatureIdentity = { kid, alg: "Ed25519" };
  return {
    kid,
    publicKeyPem,
    sign(intent: Intent, options: SignOptions = {}): SignedIntent {
      if (intent.signer && intent.signer !== kid) throw new TypeError("intent.signer must match the signing key");
      const signedIntent: Intent = { ...structuredClone(intent), signer: kid };
      const { issuedAt, expiresAt } = period(options);
      const unsigned: Omit<SignedIntentAuthorization, "signature"> = {
        version: "1.0", request_id: options.requestId ?? randomUUID(), issued_at: issuedAt,
        expires_at: expiresAt, signer: identity, intent_hash: intentHash(signedIntent),
      };
      const signature = edSign(null, Buffer.from(canonical(unsigned)), priv).toString("base64");
      return { intent: signedIntent, authorization: { ...unsigned, signature } };
    },
    approve(intent: Intent, policyRef: PolicyReference, options: ApprovalOptions = {}): SignedApproval {
      const { issuedAt, expiresAt } = period(options);
      const unsigned: Omit<SignedApproval, "signature"> = {
        version: "1.0", approval_id: options.approvalId ?? randomUUID(), issued_at: issuedAt,
        expires_at: expiresAt, approver: identity, intent_hash: intentHash(intent),
        policy_ref: structuredClone(policyRef), decision: "approve",
      };
      const signature = edSign(null, Buffer.from(canonical(unsigned)), priv).toString("base64");
      return { ...unsigned, signature };
    },
  };
}

/** Verify the signature, intent digest, signer field, and public-key binding. */
export function verifyIntentSignature(signed: SignedIntent, publicKeyPem: string): boolean {
  try {
    const expectedKid = deriveKidFromPublicKey(publicKeyPem);
    return signed.authorization.signer.kid === expectedKid && signed.intent.signer === expectedKid &&
      signed.authorization.intent_hash === intentHash(signed.intent) &&
      edVerify(null, Buffer.from(canonical(intentAuthorizationClaims(signed.authorization))),
        createPublicKey(publicKeyPem), Buffer.from(signed.authorization.signature, "base64"));
  } catch { return false; }
}

export interface SubmitResult { allowed: boolean; reason: string; receipt: unknown }

/** Submit the complete signed envelope to a gateway's /v1/evaluate. */
export async function submit(gatewayUrl: string, signed: SignedIntent, fetchImpl: typeof fetch = fetch): Promise<SubmitResult> {
  const res = await fetchImpl(gatewayUrl.replace(/\/$/, "") + "/v1/evaluate", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed),
  });
  return res.json() as Promise<SubmitResult>;
}
