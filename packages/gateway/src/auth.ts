import { createPublicKey, verify as edVerify } from "node:crypto";
import type { Intent } from "@scopebond/verify";
import { canonical, deriveKid, intentHash } from "./crypto.js";

export const AUTHORIZATION_VERSION = "1.0" as const;
export type PrincipalPurpose = "agent" | "approver";

export interface PrincipalKeyRecord {
  kid: string;
  publicKeyPem: string;
  purposes: PrincipalPurpose[];
  status?: "active" | "revoked";
  notBefore?: string;
  notAfter?: string;
}

export interface PrincipalKeyRegistry {
  resolve(kid: string, purpose: PrincipalPurpose): PrincipalKeyRecord | null | Promise<PrincipalKeyRecord | null>;
}

export class StaticPrincipalKeyRegistry implements PrincipalKeyRegistry {
  private readonly keys = new Map<string, PrincipalKeyRecord>();

  constructor(records: PrincipalKeyRecord[]) {
    for (const record of records) {
      const existing = this.keys.get(record.kid);
      if (existing) {
        if (existing.publicKeyPem !== record.publicKeyPem) throw new TypeError(`conflicting public keys for ${record.kid}`);
        existing.purposes = [...new Set([...existing.purposes, ...record.purposes])];
        if (record.status === "revoked") existing.status = "revoked";
      } else {
        this.keys.set(record.kid, structuredClone(record));
      }
    }
  }

  resolve(kid: string, purpose: PrincipalPurpose): PrincipalKeyRecord | null {
    const record = this.keys.get(kid);
    if (!record || !record.purposes.includes(purpose)) return null;
    return structuredClone(record);
  }
}

export interface SignatureIdentity {
  kid: string;
  alg: "Ed25519";
}

export interface SignedIntentAuthorization {
  version: typeof AUTHORIZATION_VERSION;
  request_id: string;
  issued_at: string;
  expires_at: string;
  signer: SignatureIdentity;
  intent_hash: string;
  signature: string;
}

export interface SignedApproval {
  version: typeof AUTHORIZATION_VERSION;
  approval_id: string;
  issued_at: string;
  expires_at: string;
  approver: SignatureIdentity;
  intent_hash: string;
  policy_ref: { id: string | null; version: number; digest: string };
  decision: "approve";
  signature: string;
}

export interface AuthorizationEvidence {
  mode: "authenticated" | "insecure_development";
  agent: SignedIntentAuthorization | null;
  approval: SignedApproval | null;
}

export interface AuthenticationConfig {
  keys: PrincipalKeyRegistry;
  /** Maximum accepted signed-envelope lifetime. Default: five minutes. */
  maxLifetimeMs?: number;
  /** Future clock skew accepted for issued_at. Default: thirty seconds. */
  maxClockSkewMs?: number;
}

export interface AuthorizationVerification {
  authorization_valid: boolean;
  agent_signature_valid: boolean;
  approval_signature_valid: boolean | null;
}

export type GatewayAuthentication = AuthenticationConfig | { mode: "insecure-development" };

export class AuthorizationError extends Error {
  constructor(message: string, public readonly status: 401 | 409 = 401) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export function intentAuthorizationClaims(value: SignedIntentAuthorization): Omit<SignedIntentAuthorization, "signature"> {
  return {
    version: value.version,
    request_id: value.request_id,
    issued_at: value.issued_at,
    expires_at: value.expires_at,
    signer: value.signer,
    intent_hash: value.intent_hash,
  };
}

export function approvalClaims(value: SignedApproval): Omit<SignedApproval, "signature"> {
  return {
    version: value.version,
    approval_id: value.approval_id,
    issued_at: value.issued_at,
    expires_at: value.expires_at,
    approver: value.approver,
    intent_hash: value.intent_hash,
    policy_ref: value.policy_ref,
    decision: value.decision,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected.slice().sort()[index]);
}

function validIdentity(value: unknown): value is SignatureIdentity {
  return isRecord(value) && hasExactKeys(value, ["alg", "kid"]) && value.alg === "Ed25519" &&
    typeof value.kid === "string" && /^key:[0-9a-f]{16}$/.test(value.kid);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 16 && value.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(value);
}

export function validateIntentAuthorization(value: unknown): value is SignedIntentAuthorization {
  if (!isRecord(value) || !hasExactKeys(value, [
    "expires_at", "intent_hash", "issued_at", "request_id", "signature", "signer", "version",
  ])) return false;
  return value.version === AUTHORIZATION_VERSION && validId(value.request_id) &&
    validTimestamp(value.issued_at) && validTimestamp(value.expires_at) && validIdentity(value.signer) &&
    typeof value.intent_hash === "string" && /^[0-9a-f]{64}$/.test(value.intent_hash) &&
    typeof value.signature === "string" && value.signature.length >= 40;
}

export function validateSignedApproval(value: unknown): value is SignedApproval {
  if (!isRecord(value) || !hasExactKeys(value, [
    "approval_id", "approver", "decision", "expires_at", "intent_hash", "issued_at", "policy_ref", "signature", "version",
  ]) || !isRecord(value.policy_ref)) return false;
  return value.version === AUTHORIZATION_VERSION && validId(value.approval_id) &&
    validTimestamp(value.issued_at) && validTimestamp(value.expires_at) && validIdentity(value.approver) &&
    typeof value.intent_hash === "string" && /^[0-9a-f]{64}$/.test(value.intent_hash) &&
    hasExactKeys(value.policy_ref, ["digest", "id", "version"]) &&
    (value.policy_ref.id === null || typeof value.policy_ref.id === "string") &&
    Number.isSafeInteger(value.policy_ref.version) && (value.policy_ref.version as number) >= 1 &&
    typeof value.policy_ref.digest === "string" && /^[0-9a-f]{64}$/.test(value.policy_ref.digest) &&
    value.decision === "approve" && typeof value.signature === "string" && value.signature.length >= 40;
}

export function validateAuthorizationEvidence(value: unknown): value is AuthorizationEvidence {
  if (!isRecord(value) || !hasExactKeys(value, ["agent", "approval", "mode"])) return false;
  if (value.mode === "insecure_development") return value.agent === null && value.approval === null;
  return value.mode === "authenticated" && validateIntentAuthorization(value.agent) &&
    (value.approval === null || validateSignedApproval(value.approval));
}

function verifyEd25519(value: unknown, signature: string, publicKeyPem: string): boolean {
  try {
    return edVerify(null, Buffer.from(canonical(value)), createPublicKey(publicKeyPem), Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

function assertFresh(issuedAt: string, expiresAt: string, now: string, maxLifetimeMs: number, maxClockSkewMs: number): void {
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  const current = Date.parse(now);
  if (![issued, expires, current].every(Number.isFinite)) throw new AuthorizationError("invalid authorization timestamp");
  if (issued > current + maxClockSkewMs) throw new AuthorizationError("authorization issued_at is in the future");
  if (expires <= current) throw new AuthorizationError("authorization expired");
  if (expires <= issued || expires - issued > maxLifetimeMs) throw new AuthorizationError("authorization lifetime is invalid");
}

async function resolveVerifiedKey(
  registry: PrincipalKeyRegistry,
  identity: SignatureIdentity,
  purpose: PrincipalPurpose,
  now: string,
): Promise<PrincipalKeyRecord> {
  const record = await registry.resolve(identity.kid, purpose);
  if (!record || record.status === "revoked") throw new AuthorizationError(`unknown or revoked ${purpose} key`);
  if (record.kid !== identity.kid || !record.purposes.includes(purpose)) throw new AuthorizationError(`${purpose} key scope mismatch`);
  let jwk: Record<string, unknown>;
  try {
    const key = createPublicKey(record.publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong algorithm");
    const raw = key.export({ format: "jwk" }) as Record<string, unknown>;
    jwk = { crv: raw.crv, kty: raw.kty, x: raw.x };
  } catch {
    throw new AuthorizationError(`invalid ${purpose} public key`);
  }
  if (deriveKid(jwk) !== identity.kid) throw new AuthorizationError(`${purpose} kid is not bound to its public key`);
  const at = Date.parse(now);
  if (record.notBefore && !Number.isFinite(Date.parse(record.notBefore))) throw new AuthorizationError(`${purpose} key has an invalid notBefore`);
  if (record.notAfter && !Number.isFinite(Date.parse(record.notAfter))) throw new AuthorizationError(`${purpose} key has an invalid notAfter`);
  if (record.notBefore && at < Date.parse(record.notBefore)) throw new AuthorizationError(`${purpose} key is not active yet`);
  if (record.notAfter && at >= Date.parse(record.notAfter)) throw new AuthorizationError(`${purpose} key has expired`);
  return record;
}

export async function authenticateRequest(
  intent: Intent,
  authorization: unknown,
  approval: unknown,
  config: AuthenticationConfig,
  now: string,
  policyRef: { id: string | null; version: number; digest: string },
  usedRequestIds: ReadonlySet<string>,
  usedApprovalIds: ReadonlySet<string>,
): Promise<{ evidence: AuthorizationEvidence; approvalForPolicy?: { approver: string; intent_hash: string } }> {
  if (!validateIntentAuthorization(authorization)) throw new AuthorizationError("a valid signed intent authorization is required");
  const maxLifetimeMs = config.maxLifetimeMs ?? 5 * 60_000;
  const maxClockSkewMs = config.maxClockSkewMs ?? 30_000;
  assertFresh(authorization.issued_at, authorization.expires_at, now, maxLifetimeMs, maxClockSkewMs);
  if (usedRequestIds.has(authorization.request_id)) throw new AuthorizationError("authorization request_id has already been used", 409);
  const computedHash = intentHash(intent);
  if (authorization.intent_hash !== computedHash) throw new AuthorizationError("signed authorization does not match the submitted intent");
  if (intent.signer !== authorization.signer.kid) throw new AuthorizationError("intent signer does not match the authenticated agent key");
  const agentKey = await resolveVerifiedKey(config.keys, authorization.signer, "agent", now);
  if (!verifyEd25519(intentAuthorizationClaims(authorization), authorization.signature, agentKey.publicKeyPem)) {
    throw new AuthorizationError("invalid agent signature");
  }

  if (approval == null) return {
    evidence: { mode: "authenticated", agent: structuredClone(authorization), approval: null },
  };
  if (!validateSignedApproval(approval)) throw new AuthorizationError("a valid signed approval is required");
  assertFresh(approval.issued_at, approval.expires_at, now, maxLifetimeMs, maxClockSkewMs);
  if (usedApprovalIds.has(approval.approval_id)) throw new AuthorizationError("approval_id has already been used", 409);
  if (approval.intent_hash !== computedHash) throw new AuthorizationError("approval does not match the submitted intent");
  if (canonical(approval.policy_ref) !== canonical(policyRef)) throw new AuthorizationError("approval does not match the active policy");
  const approverKey = await resolveVerifiedKey(config.keys, approval.approver, "approver", now);
  if (!verifyEd25519(approvalClaims(approval), approval.signature, approverKey.publicKeyPem)) {
    throw new AuthorizationError("invalid approval signature");
  }
  return {
    evidence: { mode: "authenticated", agent: structuredClone(authorization), approval: structuredClone(approval) },
    approvalForPolicy: { approver: approval.approver.kid, intent_hash: approval.intent_hash },
  };
}

export function authorizationIds(receipts: Array<{ payload?: { authorization?: AuthorizationEvidence } }>): {
  requestIds: Set<string>;
  approvalIds: Set<string>;
} {
  const requestIds = new Set<string>();
  const approvalIds = new Set<string>();
  for (const receipt of receipts) {
    const evidence = receipt.payload?.authorization;
    if (evidence?.agent?.request_id) requestIds.add(evidence.agent.request_id);
    if (evidence?.approval?.approval_id) approvalIds.add(evidence.approval.approval_id);
  }
  return { requestIds, approvalIds };
}

/** Verify preserved agent and approval evidence at the receipt timestamp. This is
 * synchronous for offline receipt verification; callers provide public records. */
export function verifyAuthorizationEvidenceSignatures(
  evidence: unknown,
  authorizedIntentHash: string,
  evidenceIntentSigner: string | undefined,
  policyRef: { id: string | null; version: number; digest: string },
  receiptTimestamp: string,
  records: PrincipalKeyRecord[],
  maxLifetimeMs = 5 * 60_000,
): AuthorizationVerification {
  if (!validateAuthorizationEvidence(evidence) || evidence.mode !== "authenticated" || !evidence.agent) {
    return { authorization_valid: false, agent_signature_valid: false, approval_signature_valid: null };
  }
  const at = Date.parse(receiptTimestamp);
  const validAtReceipt = (issuedAt: string, expiresAt: string) => {
    const issued = Date.parse(issuedAt);
    const expires = Date.parse(expiresAt);
    return [issued, expires, at].every(Number.isFinite) && issued <= at && at < expires &&
      expires > issued && expires - issued <= maxLifetimeMs;
  };
  const validRecord = (identity: SignatureIdentity, purpose: PrincipalPurpose): PrincipalKeyRecord | null => {
    const record = records.find((candidate) => candidate.kid === identity.kid && candidate.purposes.includes(purpose));
    if (!record || record.status === "revoked") return null;
    try {
      const key = createPublicKey(record.publicKeyPem);
      if (key.asymmetricKeyType !== "ed25519") return null;
      const raw = key.export({ format: "jwk" }) as Record<string, unknown>;
      if (deriveKid({ crv: raw.crv, kty: raw.kty, x: raw.x }) !== identity.kid) return null;
    } catch { return null; }
    if (record.notBefore && at < Date.parse(record.notBefore)) return null;
    if (record.notAfter && at >= Date.parse(record.notAfter)) return null;
    return record;
  };
  const agentKey = validRecord(evidence.agent.signer, "agent");
  const agent_signature_valid = evidence.agent.intent_hash === authorizedIntentHash &&
    evidenceIntentSigner === evidence.agent.signer.kid &&
    validAtReceipt(evidence.agent.issued_at, evidence.agent.expires_at) && !!agentKey &&
    verifyEd25519(intentAuthorizationClaims(evidence.agent), evidence.agent.signature, agentKey.publicKeyPem);
  if (!evidence.approval) {
    return { authorization_valid: agent_signature_valid, agent_signature_valid, approval_signature_valid: null };
  }
  const approvalKey = validRecord(evidence.approval.approver, "approver");
  const approval_signature_valid = evidence.approval.intent_hash === authorizedIntentHash &&
    canonical(evidence.approval.policy_ref) === canonical(policyRef) &&
    validAtReceipt(evidence.approval.issued_at, evidence.approval.expires_at) && !!approvalKey &&
    verifyEd25519(approvalClaims(evidence.approval), evidence.approval.signature, approvalKey.publicKeyPem);
  return {
    authorization_valid: agent_signature_valid && approval_signature_valid,
    agent_signature_valid,
    approval_signature_valid,
  };
}
