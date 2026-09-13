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
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TypeError("canonical JSON rejects non-finite numbers");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    for (let index = 0; index < v.length; index += 1) {
      if (!(index in v)) throw new TypeError("canonical JSON rejects sparse arrays");
    }
    return "[" + v.map(canonical).join(",") + "]";
  }
  if (v && typeof v === "object") {
    const prototype = Object.getPrototypeOf(v);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonical JSON accepts only plain JSON objects");
    }
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
  }
  throw new TypeError(`canonical JSON rejects ${typeof v}`);
}
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export const intentHash = (intent: Intent): string => sha256(canonical(intent));

export type RealtimeResult = "allow" | "deny" | "approved" | "timeout" | "not_evaluated";
export const EVIDENCE_VERSION = "1.0" as const;
export const CANONICALIZATION = "RFC8785" as const;
export const REDACTION_PROFILE = "scopebond:minimized-intent/v1" as const;
export const EXECUTION_STATES = [
  "simulated",
  "observed_not_evaluated",
  "denied",
  "allowed_pending",
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
}

/** Independently verify a scopebond:receipt against an attester public key (SPKI
 *  PEM): the Ed25519 signature covers the canonical payload, and the recorded
 *  intent_hash matches the intent. This is what a receipt holder runs to trust it. */
export function verifyReceipt(receipt: SignedReceipt, publicKeyPem: string): ReceiptVerification {
  if (!receipt?.payload || !receipt?.signature?.sig) {
    return {
      valid: false, signature_valid: false, intent_hash_valid: false,
      contract_valid: false, policy_ref_valid: false, supported_version: false, legacy: false,
      key_binding_valid: false,
      external_effect_verified: false,
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
    key_binding_valid = fingerprintKid(jwk) === receipt.payload.attester?.kid;
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
  return {
    valid: signature_valid && contract_valid && supported_version && intent_hash_valid && policy_ref_valid && (legacy || key_binding_valid),
    signature_valid,
    contract_valid,
    intent_hash_valid,
    policy_ref_valid,
    supported_version,
    key_binding_valid,
    legacy,
    external_effect_verified: false,
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
export function validateEvidencePayload(payload: unknown): payload is ReceiptPayload {
  if (!isRecord(payload) || !isRecord(payload.intent) || !isRecord(payload.action_ref) ||
      !isRecord(payload.policy_ref) || !isRecord(payload.execution) ||
      !isRecord(payload.redaction) || !isRecord(payload.attester)) return false;
  const state = String(payload.execution.state);
  const assertion = String(payload.execution.assertion);
  const paths = payload.redaction.paths;
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string") || new Set(paths).size !== paths.length) return false;
  const assertionForState: Partial<Record<ExecutionState, string>> = {
    simulated: "gateway_simulation",
    observed_not_evaluated: "none",
    denied: "none",
    allowed_pending: "none",
    executed: "adapter_reported_success",
    failed: "adapter_reported_failure",
    outcome_unknown: "adapter_outcome_unknown",
  };
  return hasOnlyKeys(payload, [
    "type", "evidence_version", "canonicalization", "intent", "intent_hash", "action_ref",
    "policy_hash", "policy_version", "policy_ref", "verifier_version", "realtime_result",
    "executed", "execution_ref", "execution", "redaction", "attester", "timestamp",
  ]) && hasOnlyKeys(payload.action_ref, ["authorized_intent_hash", "evidence_intent_hash"]) &&
    hasOnlyKeys(payload.policy_ref, ["id", "version", "digest"]) &&
    hasOnlyKeys(payload.execution, ["state", "assertion", "reference", "external_effect"]) &&
    hasOnlyKeys(payload.redaction, ["profile", "paths"]) &&
    hasOnlyKeys(payload.attester, ["kind", "kid"]) &&
    payload.type === "scopebond:receipt" && payload.evidence_version === EVIDENCE_VERSION &&
    payload.canonicalization === CANONICALIZATION &&
    typeof payload.intent.action_type === "string" && payload.intent.action_type.length > 0 &&
    typeof payload.intent_hash === "string" && HEX_64.test(payload.intent_hash) &&
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
    payload.attester.kind === "gateway" && typeof payload.attester.kid === "string" &&
    Number.isFinite(Date.parse(String(payload.timestamp)));
}

export async function buildReceipt(payloadFields: Omit<ReceiptPayload, "type">, attester: Attester): Promise<SignedReceipt> {
  const payload: ReceiptPayload = { type: "scopebond:receipt", ...payloadFields };
  const sig = await attester.sign(canonical(payload));
  return { payload, signature: { alg: "Ed25519", sig } };
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
  put(r: SignedReceipt): void { this.all.push(structuredClone(r)); }
  list(): SignedReceipt[] { return structuredClone(this.all); }
  executed(): Receipt[] { return structuredClone(this.all.map((r) => r.payload as unknown as Receipt)); }
  putAnchor(a: Anchor): void { this.anchorLog.push(a); }
  anchors(): Anchor[] { return this.anchorLog.slice(); }
}
