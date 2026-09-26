// Receipts: the scopebond:receipt envelope, Ed25519 countersigning, and the
// ReceiptStore interface with an in-memory implementation (D40: an interface with
// a local implementation; SQLite/D1 are edge implementations added later).

import {
  generateKeyPairSync, sign as edSign, verify as edVerify,
  createPrivateKey, createPublicKey,
} from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { Intent, Receipt, Policy } from "@scopebond/verify";
import { VERIFIER_VERSION } from "@scopebond/verify";
import type { AnchorV1, AnchorV2 } from "@scopebond/verify/anchor";
export type { AnchorV1, AnchorV2 } from "@scopebond/verify/anchor";
import { validateAuthorizationEvidence, verifyAuthorizationEvidenceSignatures } from "./auth.js";
import type { AuthorizationEvidence, PrincipalKeyRecord } from "./auth.js";
import { canonical, deriveKid, intentHash, sha256 } from "./crypto.js";
export { canonical, deriveKid, intentHash, sha256 } from "./crypto.js";

export type RealtimeResult = "allow" | "deny" | "approved" | "timeout" | "not_evaluated";

// Evidence class (GATEWAY_SPEC §15 / D65): how strong the evidence is, so a
// verifier, the workspace and every export can say what a receipt proves without
// over-claiming. It is an additive payload field; the envelope is unchanged.
export type EvidenceClass = "signed_intent" | "pep_authorized" | "boundary";
export const EVIDENCE_CLASSES: readonly EvidenceClass[] = ["signed_intent", "pep_authorized", "boundary"];
export type BoundaryGate = "merge" | "deploy" | "egress" | "platform_event";
export const BOUNDARY_GATES: readonly BoundaryGate[] = ["merge", "deploy", "egress", "platform_event"];
export type AttributionKind = "asserted" | "inferred";

/** A PEP-authorized principal: a validated identity subject and its issuer.
 *  Required when evidence_class === "pep_authorized" (no agent signature). */
export interface PepPrincipal { subject: string; issuer: string; }

/** Boundary evidence: an action already happened elsewhere and a gate decided
 *  its consequence (or attested a reported action). Required when
 *  evidence_class === "boundary". */
export interface BoundaryEvidence {
  gate: BoundaryGate;
  outcome_ref: string;
  attribution: { kind: AttributionKind; actor: string };
}
export const EVIDENCE_VERSION = "1.0" as const;
export const CANONICALIZATION = "RFC8785" as const;
export const REDACTION_PROFILE = "scopebond:minimized-intent/v1" as const;
export const EXECUTION_STATES = [
  "simulated",
  "observed_not_evaluated",
  "denied",
  "allowed_pending",
  "cooperative_allow",
  "executed",
  "failed",
  "outcome_unknown",
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export interface PolicyReference {
  id: string | null;
  version: number;
  digest: string;
}

export interface ActionReference {
  /** Stable, single-use identifier for this attempted external action. */
  action_id?: string;
  /** Digest of the full action presented to policy evaluation. */
  authorized_intent_hash: string;
  /** Digest of the minimized intent retained in this receipt. */
  evidence_intent_hash: string;
}

export interface ExecutionEvidence {
  state: ExecutionState;
  assertion: "none" | "gateway_simulation" | "adapter_reported_success" | "adapter_reported_failure" | "adapter_outcome_unknown";
  reference: string | null;
  /** Gateway/adapter assertions do not independently prove an external effect. */
  external_effect: "not_independently_verified";
}

export interface RedactionEvidence {
  profile: typeof REDACTION_PROFILE;
  paths: string[];
}

export interface ReceiptPayload {
  type: "scopebond:receipt";
  evidence_version: typeof EVIDENCE_VERSION;
  canonicalization: typeof CANONICALIZATION;
  intent: Intent;
  intent_hash: string;
  action_ref: ActionReference;
  policy_hash: string;
  policy_version: number;
  policy_ref: PolicyReference;
  verifier_version: string;
  realtime_result: RealtimeResult;
  executed: boolean;
  execution_ref: string | null;
  execution: ExecutionEvidence;
  redaction: RedactionEvidence;
  authorization: AuthorizationEvidence;
  attester: { kind: "gateway"; kid: string };
  timestamp: string;
  /** Evidence class (§15). Absent = legacy, inferred at read time as signed_intent
   *  when an agent signature is present and pep_authorized otherwise. The verifier
   *  never upgrades an explicitly set class. */
  evidence_class?: EvidenceClass;
  /** Required when evidence_class === "pep_authorized"; absent otherwise. */
  principal?: PepPrincipal;
  /** Required when evidence_class === "boundary"; absent otherwise. */
  boundary?: BoundaryEvidence;
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
function attesterFromKeyObjects(publicKey: KeyObject, privateKey: KeyObject, kid?: string): Attester {
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  const finalKid = kid ?? deriveKid(jwk);
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
export function createAttester(kid?: string): Attester {
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
  contract_valid: boolean;
  intent_hash_valid: boolean;
  policy_ref_valid: boolean;
  supported_version: boolean;
  key_binding_valid: boolean;
  legacy: boolean;
  external_effect_verified: false;
  /** The evidence class (§15), classified without ever upgrading an explicit
   *  class. Null only when the receipt has no readable payload. */
  evidence_class: EvidenceClass | null;
  authorization_valid: boolean | null;
  agent_signature_valid: boolean | null;
  approval_signature_valid: boolean | null;
  fully_valid: boolean;
}

/** Independently verify a scopebond:receipt against an attester public key (SPKI
 *  PEM): the Ed25519 signature covers the canonical payload, and the recorded
 *  intent_hash matches the intent. This is what a receipt holder runs to trust it. */
export function verifyReceipt(receipt: SignedReceipt, publicKeyPem: string, principalKeys?: PrincipalKeyRecord[]): ReceiptVerification {
  if (!receipt?.payload || !receipt?.signature?.sig) {
    return {
      valid: false, signature_valid: false, intent_hash_valid: false,
      contract_valid: false, policy_ref_valid: false, supported_version: false, legacy: false,
      key_binding_valid: false,
      external_effect_verified: false, evidence_class: null,
      authorization_valid: null, agent_signature_valid: null, approval_signature_valid: null, fully_valid: false,
    };
  }
  let signature_valid = false;
  let key_binding_valid = false;
  try {
    const key = createPublicKey(publicKeyPem);
    signature_valid = receipt.signature.alg === "Ed25519" && edVerify(
      null,
      Buffer.from(canonical(receipt.payload)),
      key,
      Buffer.from(receipt.signature.sig, "base64"),
    );
    const jwk = key.export({ format: "jwk" }) as Record<string, unknown>;
    key_binding_valid = deriveKid(jwk) === receipt.payload.attester?.kid;
  } catch {
    signature_valid = false;
  }
  const payload = receipt.payload as ReceiptPayload & { evidence_version?: string };
  const legacy = payload.evidence_version == null;
  const supported_version = legacy || payload.evidence_version === EVIDENCE_VERSION;
  const envelopeValid = hasOnlyKeys(receipt as unknown as Record<string, unknown>, ["payload", "signature"]) &&
    isRecord(receipt.signature) && hasOnlyKeys(receipt.signature as unknown as Record<string, unknown>, ["alg", "sig"]);
  const contract_valid = envelopeValid && (legacy ? validateLegacyPayload(payload) : validateEvidencePayload(payload));
  const intent_hash_valid = legacy
    ? payload.intent_hash === intentHash(payload.intent)
    : payload.action_ref?.authorized_intent_hash === payload.intent_hash &&
      payload.action_ref?.evidence_intent_hash === intentHash(payload.intent);
  const policy_ref_valid = legacy || (
    payload.policy_ref?.digest === payload.policy_hash &&
    payload.policy_ref?.version === payload.policy_version
  );
  const valid = signature_valid && contract_valid && supported_version && intent_hash_valid && policy_ref_valid && (legacy || key_binding_valid);
  const authorization = !legacy && principalKeys ? verifyAuthorizationEvidenceSignatures(
    payload.authorization, payload.action_ref.authorized_intent_hash, payload.intent.signer,
    payload.policy_ref, payload.timestamp, principalKeys,
  ) : null;
  return {
    valid,
    signature_valid,
    contract_valid,
    intent_hash_valid,
    policy_ref_valid,
    supported_version,
    key_binding_valid,
    legacy,
    external_effect_verified: false,
    evidence_class: classifyEvidenceClass(payload as ReceiptPayload),
    authorization_valid: authorization?.authorization_valid ?? null,
    agent_signature_valid: authorization?.agent_signature_valid ?? null,
    approval_signature_valid: authorization?.approval_signature_valid ?? null,
    fully_valid: valid && authorization?.authorization_valid === true,
  };
}

const HEX_64 = /^[0-9a-f]{64}$/;
const ASSERTIONS = new Set([
  "none", "gateway_simulation", "adapter_reported_success",
  "adapter_reported_failure", "adapter_outcome_unknown",
]);
const REALTIME = new Set(["allow", "deny", "approved", "timeout", "not_evaluated"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length <= allowed.length && keys.every((key) => allowed.includes(key));
}

function validateLegacyPayload(payload: unknown): boolean {
  if (!isRecord(payload) || !isRecord(payload.intent) || !isRecord(payload.attester)) return false;
  return hasOnlyKeys(payload, [
    "type", "intent", "intent_hash", "policy_hash", "policy_version", "verifier_version",
    "realtime_result", "executed", "execution_ref", "approval", "attester", "timestamp",
  ]) && hasOnlyKeys(payload.attester, ["kind", "kid"]) &&
    payload.type === "scopebond:receipt" &&
    typeof payload.intent.action_type === "string" && payload.intent.action_type.length > 0 &&
    typeof payload.intent_hash === "string" && typeof payload.policy_hash === "string" &&
    Number.isSafeInteger(payload.policy_version) && (payload.policy_version as number) >= 1 &&
    typeof payload.verifier_version === "string" && REALTIME.has(String(payload.realtime_result)) &&
    typeof payload.executed === "boolean" && payload.attester.kind === "gateway" &&
    typeof payload.attester.kid === "string" && Number.isFinite(Date.parse(String(payload.timestamp)));
}

/** Runtime verifier for the signed v1 payload invariants. Full request/policy
 * input validation is a separate boundary completed in DEV09/DEV14. */
/** The evidence class of a receipt (§15). An explicit class is returned as-is —
 *  never upgraded. A legacy receipt (no class) is inferred: signed_intent when an
 *  agent signature is present, pep_authorized otherwise. */
export function classifyEvidenceClass(payload: ReceiptPayload): EvidenceClass {
  if (payload.evidence_class) return payload.evidence_class;
  return payload.authorization?.agent ? "signed_intent" : "pep_authorized";
}

/** Class-required fields hold and no foreign class fields are smuggled in. */
function evidenceClassValid(payload: ReceiptPayload): boolean {
  const cls = payload.evidence_class;
  if (cls !== undefined && !EVIDENCE_CLASSES.includes(cls)) return false;
  const hasPrincipal = payload.principal !== undefined;
  const hasBoundary = payload.boundary !== undefined;
  if (cls === "pep_authorized") {
    const pr = payload.principal;
    if (hasBoundary || !isRecord(pr) || !hasOnlyKeys(pr, ["subject", "issuer"])) return false;
    return typeof pr.subject === "string" && pr.subject.length > 0 &&
      typeof pr.issuer === "string" && pr.issuer.length > 0;
  }
  if (cls === "boundary") {
    const b = payload.boundary as unknown;
    if (hasPrincipal || !isRecord(b) || !hasOnlyKeys(b, ["gate", "outcome_ref", "attribution"])) return false;
    if (!BOUNDARY_GATES.includes(b.gate as BoundaryGate)) return false;
    if (typeof b.outcome_ref !== "string" || b.outcome_ref.length === 0) return false;
    const at = b.attribution;
    if (!isRecord(at) || !hasOnlyKeys(at, ["kind", "actor"])) return false;
    if (at.kind !== "asserted" && at.kind !== "inferred") return false;
    return typeof at.actor === "string" && at.actor.length > 0;
  }
  // signed_intent or legacy (undefined): no class-specific fields are permitted.
  return !hasPrincipal && !hasBoundary;
}

export function validateEvidencePayload(payload: unknown): payload is ReceiptPayload {
  if (!isRecord(payload) || !isRecord(payload.intent) || !isRecord(payload.action_ref) ||
      !isRecord(payload.policy_ref) || !isRecord(payload.execution) ||
      !isRecord(payload.redaction) || !isRecord(payload.authorization) || !isRecord(payload.attester)) return false;
  const state = String(payload.execution.state);
  const assertion = String(payload.execution.assertion);
  const paths = payload.redaction.paths;
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string") || new Set(paths).size !== paths.length) return false;
  const assertionForState: Partial<Record<ExecutionState, string>> = {
    simulated: "gateway_simulation",
    observed_not_evaluated: "none",
    denied: "none",
    allowed_pending: "none",
    cooperative_allow: "none",
    executed: "adapter_reported_success",
    failed: "adapter_reported_failure",
    outcome_unknown: "adapter_outcome_unknown",
  };
  return hasOnlyKeys(payload, [
    "type", "evidence_version", "canonicalization", "intent", "intent_hash", "action_ref",
    "policy_hash", "policy_version", "policy_ref", "verifier_version", "realtime_result",
    "executed", "execution_ref", "execution", "redaction", "authorization", "attester", "timestamp",
    "evidence_class", "principal", "boundary",
  ]) && evidenceClassValid(payload as unknown as ReceiptPayload) &&
    hasOnlyKeys(payload.action_ref, ["action_id", "authorized_intent_hash", "evidence_intent_hash"]) &&
    hasOnlyKeys(payload.policy_ref, ["id", "version", "digest"]) &&
    hasOnlyKeys(payload.execution, ["state", "assertion", "reference", "external_effect"]) &&
    hasOnlyKeys(payload.redaction, ["profile", "paths"]) &&
    hasOnlyKeys(payload.attester, ["kind", "kid"]) &&
    payload.type === "scopebond:receipt" && payload.evidence_version === EVIDENCE_VERSION &&
    payload.canonicalization === CANONICALIZATION &&
    typeof payload.intent.action_type === "string" && payload.intent.action_type.length > 0 &&
    typeof payload.intent_hash === "string" && HEX_64.test(payload.intent_hash) &&
    (payload.action_ref.action_id === undefined || (typeof payload.action_ref.action_id === "string" && payload.action_ref.action_id.length >= 16 && payload.action_ref.action_id.length <= 200)) &&
    typeof payload.action_ref.authorized_intent_hash === "string" && HEX_64.test(payload.action_ref.authorized_intent_hash) &&
    typeof payload.action_ref.evidence_intent_hash === "string" && HEX_64.test(payload.action_ref.evidence_intent_hash) &&
    typeof payload.policy_hash === "string" && HEX_64.test(payload.policy_hash) &&
    Number.isSafeInteger(payload.policy_version) && (payload.policy_version as number) >= 1 &&
    (payload.policy_ref.id === null || typeof payload.policy_ref.id === "string") &&
    Number.isSafeInteger(payload.policy_ref.version) && typeof payload.policy_ref.digest === "string" &&
    typeof payload.verifier_version === "string" && REALTIME.has(String(payload.realtime_result)) &&
    ((state === "observed_not_evaluated") === (payload.realtime_result === "not_evaluated")) &&
    EXECUTION_STATES.includes(state as ExecutionState) && ASSERTIONS.has(assertion) &&
    (assertionForState[state as ExecutionState] == null || assertionForState[state as ExecutionState] === assertion) &&
    typeof payload.executed === "boolean" && payload.executed === (state === "executed") &&
    (payload.execution.reference === null || typeof payload.execution.reference === "string") &&
    payload.execution.reference === payload.execution_ref &&
    payload.execution.external_effect === "not_independently_verified" &&
    payload.redaction.profile === REDACTION_PROFILE &&
    validateAuthorizationEvidence(payload.authorization) &&
    (payload.authorization.mode !== "authenticated" || payload.action_ref.action_id === undefined || payload.action_ref.action_id === payload.authorization.agent?.request_id) &&
    payload.attester.kind === "gateway" && typeof payload.attester.kid === "string" &&
    Number.isFinite(Date.parse(String(payload.timestamp)));
}

export async function buildReceipt(payloadFields: Omit<ReceiptPayload, "type">, attester: Attester): Promise<SignedReceipt> {
  const payload: ReceiptPayload = { type: "scopebond:receipt", ...payloadFields };
  const sig = await attester.sign(canonical(payload));
  return { payload, signature: { alg: "Ed25519", sig } };
}

export interface BoundaryReceiptInput {
  /** The normalized action the gate observed (e.g. a `pr.merge`). */
  intent: Intent;
  /** The policy the gate decided against (pins policy_hash / version / ref). */
  policy: Policy;
  gate: BoundaryGate;
  /** The outcome reference: a PR head SHA, a deployment id, an event id. */
  outcomeRef: string;
  attribution: { kind: AttributionKind; actor: string };
  /** The gate verdict: `allow` / `deny` (evaluated) or `not_evaluated` (attestation). */
  realtimeResult: RealtimeResult;
  /** Injectable clock for determinism/testing. */
  now?: () => string;
}

/** Build and sign a boundary-class receipt (§15 / D65). A gate decided the
 *  consequence of an action that already happened elsewhere; there is no agent
 *  signature (`authorization.mode: "boundary"`), and the identity is the
 *  attribution. Reusable by any boundary-lane connector (GitHub App, host agent). */
export async function buildBoundaryReceipt(input: BoundaryReceiptInput, attester: Attester): Promise<SignedReceipt> {
  const ts = input.now?.() ?? new Date().toISOString();
  const minimized = minimizeIntentForEvidence(input.intent);
  const authorizedHash = intentHash(input.intent);
  const evidenceHash = intentHash(minimized.intent);
  const policyHash = sha256(canonical(input.policy as unknown as Record<string, unknown>));
  const policyVersion = typeof (input.policy as { version?: unknown }).version === "number" ? (input.policy as { version: number }).version : 1;
  const policyId = typeof (input.policy as { policy_id?: unknown }).policy_id === "string" ? (input.policy as { policy_id: string }).policy_id : null;
  const state: ExecutionState =
    input.realtimeResult === "deny" ? "denied" :
    input.realtimeResult === "not_evaluated" ? "observed_not_evaluated" :
    "cooperative_allow";
  return buildReceipt({
    evidence_version: EVIDENCE_VERSION,
    canonicalization: CANONICALIZATION,
    intent: minimized.intent,
    intent_hash: authorizedHash,
    // Idempotency key: stable per (gate, outcome, intent) so re-evaluating the same
    // PR head / deployment dedupes at the outbox and at ingest.
    action_ref: { action_id: sha256(canonical({ gate: input.gate, outcome_ref: input.outcomeRef, intent_hash: authorizedHash })), authorized_intent_hash: authorizedHash, evidence_intent_hash: evidenceHash },
    policy_hash: policyHash,
    policy_version: policyVersion,
    policy_ref: { id: policyId, version: policyVersion, digest: policyHash },
    verifier_version: BOUNDARY_VERIFIER_VERSION,
    realtime_result: input.realtimeResult,
    executed: false,
    execution_ref: null,
    execution: { state, assertion: "none", reference: null, external_effect: "not_independently_verified" },
    redaction: { profile: REDACTION_PROFILE, paths: minimized.redactedPaths },
    authorization: { mode: "boundary", agent: null, approval: null },
    attester: { kind: "gateway", kid: attester.kid },
    timestamp: ts,
    evidence_class: "boundary",
    boundary: { gate: input.gate, outcome_ref: input.outcomeRef, attribution: input.attribution },
  }, attester);
}

// Imported rather than repeated: SPEC.md says this names the violates() version that
// produced the verdict, and the literal that used to live here drifted three releases
// behind the real one, so every receipt misnamed its own verifier.
const BOUNDARY_VERIFIER_VERSION = VERIFIER_VERSION;

export interface PepReceiptInput {
  /** The normalized action the proxy/PEP decided (e.g. an `mcp.tool.call`). */
  intent: Intent;
  /** The policy the PEP decided against (pins policy_hash / version / ref). */
  policy: Policy;
  /** The validated identity the request carried (subject + issuer). */
  principal: PepPrincipal;
  /** The verdict: `allow` / `deny` (evaluated) or `not_evaluated`. */
  realtimeResult: RealtimeResult;
  now?: () => string;
}

/** Build and sign a PEP-authorized receipt (§15). A proxy/PEP decided a request
 *  carrying the caller's own identity; there is no agent signature
 *  (`authorization.mode: "pep"`), and the identity is the principal. It attests
 *  the PEP authorized this normalized action for this principal — never agent
 *  non-repudiation. Reusable by any M1/PEP connector (the MCP proxy, interceptors). */
export async function buildPepReceipt(input: PepReceiptInput, attester: Attester): Promise<SignedReceipt> {
  const ts = input.now?.() ?? new Date().toISOString();
  const minimized = minimizeIntentForEvidence(input.intent);
  const authorizedHash = intentHash(input.intent);
  const evidenceHash = intentHash(minimized.intent);
  const policyHash = sha256(canonical(input.policy as unknown as Record<string, unknown>));
  const policyVersion = typeof (input.policy as { version?: unknown }).version === "number" ? (input.policy as { version: number }).version : 1;
  const policyId = typeof (input.policy as { policy_id?: unknown }).policy_id === "string" ? (input.policy as { policy_id: string }).policy_id : null;
  const state: ExecutionState =
    input.realtimeResult === "deny" ? "denied" :
    input.realtimeResult === "not_evaluated" ? "observed_not_evaluated" :
    "cooperative_allow";
  return buildReceipt({
    evidence_version: EVIDENCE_VERSION,
    canonicalization: CANONICALIZATION,
    intent: minimized.intent,
    intent_hash: authorizedHash,
    // Idempotency key: unique per authorized call (intent + time + principal), so a
    // retried batch dedupes while distinct tool calls stay distinct.
    action_ref: { action_id: sha256(canonical({ intent_hash: authorizedHash, ts, subject: input.principal.subject })), authorized_intent_hash: authorizedHash, evidence_intent_hash: evidenceHash },
    policy_hash: policyHash,
    policy_version: policyVersion,
    policy_ref: { id: policyId, version: policyVersion, digest: policyHash },
    verifier_version: BOUNDARY_VERIFIER_VERSION,
    realtime_result: input.realtimeResult,
    executed: false,
    execution_ref: null,
    execution: { state, assertion: "none", reference: null, external_effect: "not_independently_verified" },
    redaction: { profile: REDACTION_PROFILE, paths: minimized.redactedPaths },
    authorization: { mode: "pep", agent: null, approval: null },
    attester: { kind: "gateway", kid: attester.kid },
    timestamp: ts,
    evidence_class: "pep_authorized",
    principal: { subject: input.principal.subject, issuer: input.principal.issuer },
  }, attester);
}

const SECRET_KEYS = new Set([
  "authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "api-key",
  "apikey", "password", "passwd", "secret", "client-secret", "client_secret", "access-token",
  "access_token", "refresh-token", "refresh_token", "private-key", "private_key",
]);

function normalizedKey(key: string): string {
  return key.trim().toLowerCase().replace(/_/g, "-");
}

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key) || key === "token" || key === "credential" ||
    key.endsWith("-token") || key.endsWith("-secret") || key.endsWith("-password") ||
    key.endsWith("-private-key");
}

function byteLength(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value);
  return Buffer.byteLength(canonical(value));
}

function minimizeValue(value: unknown, path: string, redacted: string[]): unknown {
  if (Array.isArray(value)) return value.map((item, index) => minimizeValue(item, `${path}[${index}]`, redacted));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    const normalized = normalizedKey(key);
    if (isSecretKey(normalized)) {
      output[key] = "[REDACTED]";
      redacted.push(childPath);
    } else if (normalized === "body" || normalized === "request-body") {
      output[key] = {
        content_digest: `sha256:${sha256(typeof child === "string" ? child : canonical(child))}`,
        byte_length: byteLength(child),
      };
      redacted.push(childPath);
    } else {
      output[key] = minimizeValue(child, childPath, redacted);
    }
  }
  return output;
}

/** Minimize an intent before it enters a signed receipt. Policy evaluation and
 * execution still receive the original intent; this copy is evidence only. */
export function minimizeIntentForEvidence(intent: Intent): { intent: Intent; redactedPaths: string[] } {
  const redactedPaths: string[] = [];
  const minimized = minimizeValue(intent, "intent", redactedPaths) as Intent;
  return { intent: minimized, redactedPaths: redactedPaths.sort() };
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

/** A tamper-evidence anchor: a Merkle root committing to the first receipts of
 *  the log (append order), chained to the previous anchor. Verifiers dispatch on
 *  `algo`: v1 `"sha256-merkle"` (legacy, unsigned) or v2 `"rfc9162-sha256"`
 *  (RFC 9162 tree, Ed25519-signed by the attester). See SPEC.md "Anchors". */
export type Anchor = AnchorV1 | AnchorV2;

export interface ReceiptStore {
  put(r: SignedReceipt): void | Promise<void>;
  /** Every receipt in append order. The position in this list is the receipt's
   *  stable log sequence (its anchor leaf index); a store MUST NOT reorder,
   *  remove or insert before existing receipts. Anchoring refuses to sign a log
   *  that no longer matches the previous anchor. */
  list(): SignedReceipt[] | Promise<SignedReceipt[]>;
  /** The receipt payloads, for feeding claim-time-style evaluation to verify. */
  executed(): Receipt[] | Promise<Receipt[]>;
  /** The newest `limit` receipts, newest first — a tail without reading the whole log.
   *  Optional: a caller must fall back to `list()` when a store does not implement it. */
  recent?(limit: number): SignedReceipt[] | Promise<SignedReceipt[]>;
  /** How many receipts are stored, without reading them. Optional. */
  count?(): number | Promise<number>;
  /** Release any underlying handle (e.g. a SQLite connection). Optional, but a
   *  short-lived writer SHOULD call it: an unclosed SQLite handle leaves its
   *  write-ahead log on disk for the next process to grow further. */
  close?(): void | Promise<void>;
  /** Append an anchor. Optional — a store that supports anchoring implements both. */
  putAnchor?(a: Anchor): void | Promise<void>;
  anchors?(): Anchor[] | Promise<Anchor[]>;
  /** Atomically evaluate and consume an action id against prior committed or
   * conservatively held authority. Stores without this capability cannot safely
   * support dispatch executors. */
  reserveAction?<T extends { allow: boolean }>(
    reservation: AuthorityReservation,
    decide: (prior: Receipt[]) => T,
  ): AuthorityReservationResult<T> | Promise<AuthorityReservationResult<T>>;
  /** Atomically persist the terminal receipt and move the write-ahead record out
   * of reserved state. Unknown outcomes remain charged conservatively. */
  finalizeAction?(actionId: string, receipt: SignedReceipt, state: AuthorityFinalState): void | Promise<void>;
  /** Persist the signed pre-dispatch attestation before any external I/O. */
  prepareDispatch?(actionId: string, receipt: SignedReceipt, adapterId: string): void | Promise<void>;
  /** Read one lifecycle record or the unresolved set for retry-safe reconciliation. */
  getAction?(actionId: string): ActionLifecycleRecord | null | Promise<ActionLifecycleRecord | null>;
  unresolvedActions?(): ActionLifecycleRecord[] | Promise<ActionLifecycleRecord[]>;
  /** Durable emergency state. `agents` contains signer key ids. */
  getStopState?(): StopState | Promise<StopState>;
  setStopped?(target: "global" | string, stopped: boolean): void | Promise<void>;
}

export interface StopState { global: boolean; agents: string[]; }

export interface AuthorityReservation {
  action_id: string;
  candidate: Receipt;
  policy_ref: PolicyReference;
  policy_snapshot: string;
  /** IDs consumed by the same atomic reservation as budget authority. */
  authorization_ids?: { request_id?: string; approval_id?: string };
  /** Minimized, reconstructible receipt fields fixed before reservation. */
  receipt_context?: ReceiptContext;
}

export type ReceiptContext = Omit<
  ReceiptPayload,
  "type" | "realtime_result" | "executed" | "execution_ref" | "execution"
>;

export type AuthorityFinalState = "denied" | "simulated" | "cooperative_allow" | "executed" | "failed" | "outcome_unknown";
export type AuthorityLifecycleState = "reserved" | "dispatching" | AuthorityFinalState;

export interface ActionLifecycleRecord {
  action_id: string;
  state: AuthorityLifecycleState;
  reservation: AuthorityReservation;
  realtime_result: RealtimeResult | null;
  adapter_id: string | null;
  pre_receipt: SignedReceipt | null;
  terminal_receipt: SignedReceipt | null;
}

export type AuthorityReservationResult<T> =
  | { duplicate: true }
  | { duplicate: false; decision: T };

interface MemoryAuthorityRecord {
  reservation: AuthorityReservation;
  state: AuthorityLifecycleState;
  realtimeResult: RealtimeResult | null;
  adapterId: string | null;
  preReceipt: SignedReceipt | null;
  terminalReceipt: SignedReceipt | null;
}

export class MemoryReceiptStore implements ReceiptStore {
  private all: SignedReceipt[] = [];
  private anchorLog: Anchor[] = [];
  private authority = new Map<string, MemoryAuthorityRecord>();
  private consumedAuthorizationIds = new Map<string, string>();
  private stops = new Set<string>();
  put(r: SignedReceipt): void { this.all.push(structuredClone(r)); }
  list(): SignedReceipt[] { return structuredClone(this.all); }
  executed(): Receipt[] {
    const receipts = this.all.map((r) => r.payload as unknown as Receipt);
    const held = [...this.authority.values()]
      .filter((record) => record.state === "reserved" || record.state === "dispatching" || record.state === "outcome_unknown")
      .map((record) => record.reservation.candidate);
    return structuredClone([...receipts, ...held]);
  }
  reserveAction<T extends { allow: boolean }>(reservation: AuthorityReservation, decide: (prior: Receipt[]) => T): AuthorityReservationResult<T> {
    if (this.authority.has(reservation.action_id)) return { duplicate: true };
    for (const id of Object.values(reservation.authorization_ids ?? {})) {
      if (id && this.consumedAuthorizationIds.has(id)) return { duplicate: true };
    }
    const decision = decide(this.executed());
    this.authority.set(reservation.action_id, {
      reservation: structuredClone(reservation),
      state: decision.allow ? "reserved" : "denied",
      realtimeResult: "realtime_result" in decision ? decision.realtime_result as RealtimeResult : null,
      adapterId: null,
      preReceipt: null,
      terminalReceipt: null,
    });
    for (const id of Object.values(reservation.authorization_ids ?? {})) {
      if (id) this.consumedAuthorizationIds.set(id, reservation.action_id);
    }
    return { duplicate: false, decision };
  }
  prepareDispatch(actionId: string, receipt: SignedReceipt, adapterId: string): void {
    const record = this.authority.get(actionId);
    if (!record || record.state !== "reserved") throw new Error(`action ${actionId} is not reserved for dispatch`);
    record.state = "dispatching";
    record.adapterId = adapterId;
    record.preReceipt = structuredClone(receipt);
  }
  finalizeAction(actionId: string, receipt: SignedReceipt, state: AuthorityFinalState): void {
    const record = this.authority.get(actionId);
    if (!record) throw new Error(`unknown authority reservation ${actionId}`);
    this.all.push(structuredClone(receipt));
    record.state = state;
    record.terminalReceipt = structuredClone(receipt);
  }
  getAction(actionId: string): ActionLifecycleRecord | null {
    const record = this.authority.get(actionId);
    return record ? lifecycleRecord(actionId, record) : null;
  }
  unresolvedActions(): ActionLifecycleRecord[] {
    return [...this.authority.entries()]
      .filter(([, record]) => record.state === "reserved" || record.state === "dispatching" || record.state === "outcome_unknown")
      .map(([actionId, record]) => lifecycleRecord(actionId, record));
  }
  getStopState(): StopState { return { global: this.stops.has("global"), agents: [...this.stops].filter((key) => key !== "global") }; }
  setStopped(target: "global" | string, stopped: boolean): void {
    if (stopped) this.stops.add(target); else this.stops.delete(target);
  }
  putAnchor(a: Anchor): void { this.anchorLog.push(a); }
  anchors(): Anchor[] { return this.anchorLog.slice(); }
}

function lifecycleRecord(actionId: string, record: MemoryAuthorityRecord): ActionLifecycleRecord {
  return structuredClone({
    action_id: actionId,
    state: record.state,
    reservation: record.reservation,
    realtime_result: record.realtimeResult,
    adapter_id: record.adapterId,
    pre_receipt: record.preReceipt,
    terminal_receipt: record.terminalReceipt,
  });
}
