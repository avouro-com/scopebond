// Signed observations (scopebond:observation v1): the envelope, its signature and the
// closed payloads this hook may produce.
//
// An observation is a separate, versioned record beside the receipt. Receipts, their
// canonicalization and their signatures are unchanged. The signature covers the literal
// domain `scopebond:observation/v1\n` followed by the RFC 8785 canonical payload; the
// observation hash is the SHA-256 of the same bytes. The wire wrapper is
// `{ payload, signature: { alg, kid, value } }` and nothing else.
//
// This hook holds an agent-adapter key, so it may emit only these kinds: session,
// capability, health, policy_ack, tool_intent and tool_outcome. Verification, platform
// outcomes and integrity results come from other sources and are not producible here
// (`assertAgentKind` refuses them).
//
// Nothing here carries raw content. Every path, host-local target, command and session
// identifier is reduced to a keyed opaque id or a closed enum before it is placed in a
// payload; the key stays on this machine and is never uploaded.

import { createHash, createHmac, createPrivateKey, randomUUID, sign as edSign, type KeyObject } from "node:crypto";
import { loadOrCreateHexKey } from "./safe-fs.js";
import { join } from "node:path";
import { redactCommand, scrubParam } from "./minimize.js";
import type { FileProbe } from "./typed-infra.js";
import { deriveTypedOperations, gitPushOperation, type CallRequest, type GitProbe, type TypedContext } from "./typed-ops.js";
export type { CallRequest } from "./typed-ops.js";
import { canonical } from "@scopebond/policy-schema/canonical";
import {
  OBSERVATION_DOMAIN, OBSERVATION_LIMITS, OBSERVATION_TYPE, OBSERVATION_VERSION, SOURCE_RECEIPT_DOMAIN,
  observationSigningInput,
} from "@scopebond/policy-schema";

/** The kinds an agent-adapter key may emit. Anything else is another source's to send. */
export const AGENT_KINDS = ["session", "capability", "health", "policy_ack", "tool_intent", "tool_outcome"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export function assertAgentKind(kind: string): asserts kind is AgentKind {
  if (!(AGENT_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`an agent-adapter key may not emit "${kind}" observations`);
  }
}

export interface ObservationPayload {
  type: typeof OBSERVATION_TYPE;
  version: typeof OBSERVATION_VERSION;
  observation_id: string;
  installation_id: string;
  installation_generation: number;
  session_id?: string;
  parent_action_id?: string;
  source_receipt_hash?: string;
  kind: AgentKind;
  occurred_at: string;
  sequence: number;
  data: Record<string, unknown>;
}

export interface SignedObservation {
  payload: ObservationPayload;
  signature: { alg: "Ed25519"; kid: string; value: string };
}

export const MAX_OBSERVATION_BYTES = OBSERVATION_LIMITS.maxObservationBytes;
export const MAX_BATCH_ITEMS = OBSERVATION_LIMITS.maxBatchItems;
export const MAX_BATCH_BODY_BYTES = OBSERVATION_LIMITS.maxBatchBodyBytes;

const KID = /^[A-Za-z0-9:._-]{1,200}$/;

export interface ObservationSigner {
  kid: string;
  /** Ed25519 over the given UTF-8 text; unpadded base64url. */
  sign(text: string): string;
}

/** A signer from the enrolled agent key's PEM. `kid` is the id the workspace registered
 *  for this key at enrollment; it is never derived or guessed here. */
export function observationSigner(privateKeyPem: string, kid: string): ObservationSigner {
  if (!KID.test(kid)) throw new TypeError("the enrolled key id is not a valid observation key id");
  const key: KeyObject = createPrivateKey(privateKeyPem);
  return {
    kid,
    sign: (text) => edSign(null, Buffer.from(text, "utf8"), key).toString("base64url"),
  };
}

/** The bytes a signature (and the observation hash) cover: domain, then canonical payload. */
export const signingBytes = (payload: ObservationPayload): Buffer =>
  Buffer.from(observationSigningInput(payload as unknown as Record<string, unknown>), "utf8");

/** SHA-256 of the signing bytes: 64 lowercase hex. Not proof of signature validity. */
export const observationHash = (payload: ObservationPayload): string =>
  createHash("sha256").update(signingBytes(payload)).digest("hex");

/** SHA-256 of `scopebond:source-receipt/v1\n` + canonical full signed receipt envelope. */
export const sourceReceiptHash = (receipt: unknown): string =>
  createHash("sha256").update(SOURCE_RECEIPT_DOMAIN + canonical(receipt), "utf8").digest("hex");

/** Sign a payload into its wire wrapper. Throws on a payload the server would refuse
 *  outright: the wrong kind, or larger than one observation may be. */
export function signObservation(payload: ObservationPayload, signer: ObservationSigner): SignedObservation {
  assertAgentKind(payload.kind);
  const wrapper: SignedObservation = {
    payload,
    signature: { alg: "Ed25519", kid: signer.kid, value: signer.sign(OBSERVATION_DOMAIN + canonical(payload)) },
  };
  if (Buffer.byteLength(JSON.stringify(wrapper), "utf8") > MAX_OBSERVATION_BYTES) {
    throw new RangeError(`observation exceeds ${MAX_OBSERVATION_BYTES} bytes`);
  }
  return wrapper;
}

/** RFC 3339 UTC with millisecond precision, as the schema requires (`...Z`). */
export const utc = (ms: number): string => new Date(ms).toISOString();

export const newObservationId = (): string => randomUUID();

// ---- installation-local keyed ids and the request binding ------------------------------

/** The installation-local correlation key: 32 random bytes that never leave this machine.
 *  Its generation id is derived from the key, so rotating the key changes it and ids from
 *  two keys can never be joined. */
export const BINDING_KEY_FILE = "observation-binding.key";
export const REQUEST_BINDING_DOMAIN = "scopebond:request-binding/v1\n";
const RESOURCE_ID_DOMAIN = "scopebond:resource-id/v1\n";
const SESSION_ID_DOMAIN = "scopebond:session-id/v1\n";
const KEY_GENERATION_DOMAIN = "scopebond:request-binding-key/v1\n";

export interface BindingKey {
  /** Opaque id of this key generation; safe to upload (it reveals nothing of the key). */
  generation: string;
  /** HMAC-SHA-256 request binding: domain + canonical actual dispatch request. */
  requestDigest(request: unknown): string;
  /** A keyed opaque id for a resource (a path, a ref, a host-local target). */
  resourceId(kind: string, value: string): string;
  /** A keyed opaque id for a harness session id, stable across hook processes. */
  sessionId(harnessSessionId: string): string;
}

export function bindingKeyFromHex(hex: string): BindingKey {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new TypeError("invalid request-binding key");
  const key = Buffer.from(hex, "hex");
  const mac = (text: string): string => createHmac("sha256", key).update(text, "utf8").digest("hex");
  return {
    generation: `bk_${createHash("sha256").update(KEY_GENERATION_DOMAIN).update(key).digest("hex").slice(0, 16)}`,
    requestDigest: (request) => mac(REQUEST_BINDING_DOMAIN + canonical(request)),
    resourceId: (kind, value) => `sbr_${mac(`${RESOURCE_ID_DOMAIN}${kind}\0${value}`).slice(0, 32)}`,
    sessionId: (id) => `sbs_${mac(SESSION_ID_DOMAIN + id).slice(0, 32)}`,
  };
}

/** Load (or create, 0600) the installation-local key beside the other hook keys. */
export function loadOrCreateBindingKey(dir: string): BindingKey {
  return bindingKeyFromHex(loadOrCreateHexKey(join(dir, BINDING_KEY_FILE)));
}

// ---- payload construction ----------------------------------------------------------------

export interface EnvelopeContext {
  installationId: string;
  generation: number;
}

export interface ObservationDraft {
  kind: AgentKind;
  occurredAt: number;
  /** Already-derived opaque session id, when the observation belongs to one. */
  sessionId?: string;
  parentActionId?: string;
  sourceReceiptHash?: string;
  /** Kind-specific data. `sequence` is filled in by the outbox where the union repeats it. */
  data: Record<string, unknown>;
  /** Give a retry the same id. Defaults to a new UUID. */
  observationId?: string;
}

/** Drop undefined so the payload is a closed object with absent optionals omitted. */
export function compact<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v;
  return out as T;
}

/** Build the payload for a draft at an allocated sequence. Repeated fields in `data`
 *  (session id, generation, sequence, linkage) are set from the envelope, so they cannot
 *  disagree with it. */
export function buildPayload(draft: ObservationDraft, context: EnvelopeContext, sequence: number): ObservationPayload {
  assertAgentKind(draft.kind);
  const data: Record<string, unknown> = { ...draft.data };
  if (draft.kind === "session") { data.session_id = draft.sessionId; data.sequence = sequence; }
  if (draft.kind === "health" && data.event === "heartbeat") data.session_id = draft.sessionId;
  if (draft.kind === "policy_ack") data.installation_generation = context.generation;
  if (draft.kind === "tool_intent" || draft.kind === "tool_outcome") {
    data.parent_action_id = draft.parentActionId;
    data.source_receipt_hash = draft.sourceReceiptHash;
  }
  return compact({
    type: OBSERVATION_TYPE,
    version: OBSERVATION_VERSION,
    observation_id: draft.observationId ?? newObservationId(),
    installation_id: context.installationId,
    installation_generation: context.generation,
    session_id: draft.sessionId,
    parent_action_id: draft.parentActionId,
    source_receipt_hash: draft.sourceReceiptHash,
    kind: draft.kind,
    occurred_at: utc(draft.occurredAt),
    sequence,
    data: compact(data),
  }) as ObservationPayload;
}

// ---- kind-specific data builders -----------------------------------------------------------

export const SESSION_STOP_REASONS = ["completed", "failed", "cancelled", "sleep", "unknown"] as const;
export type SessionStopReason = (typeof SESSION_STOP_REASONS)[number];

export const sessionStartData = (repositoryId?: string) => compact({ event: "start", repository_id: repositoryId });
export const sessionStopData = (reason: SessionStopReason, repositoryId?: string) =>
  compact({ event: "stop", stop_reason: reason, repository_id: repositoryId });

export const heartbeatData = (leaseActive: boolean, extra: { policyDigest?: string; clockOffsetMs?: number; intervalS?: number } = {}) =>
  compact({
    event: "heartbeat", lease_active: leaseActive, policy_digest: extra.policyDigest,
    clock_offset_ms: extra.clockOffsetMs === undefined ? undefined : Math.max(-86_400_000, Math.min(86_400_000, Math.round(extra.clockOffsetMs))),
    // How often this computer beats, so the workspace waits three of these before calling it lost (60–900 s).
    interval_s: extra.intervalS !== undefined && Number.isInteger(extra.intervalS) && extra.intervalS >= 60 && extra.intervalS <= 900 ? extra.intervalS : undefined,
  });

/** Oldest pending receipt time and backlog size. `count` 0 reports a drained queue
 *  (the timestamp is then the report time: the schema requires one). */
export const queueData = (oldestPendingAtMs: number, pendingCount: number, policyDigest?: string) =>
  compact({ event: "queue", oldest_pending_at: utc(oldestPendingAtMs), pending_count: Math.max(0, Math.min(1_000_000_000, Math.trunc(pendingCount))), policy_digest: policyDigest });

export const POLICY_LOAD_ERRORS = ["schema_invalid", "signature_invalid", "scope_mismatch", "unsupported"] as const;
export type PolicyLoadError = (typeof POLICY_LOAD_ERRORS)[number];

export interface PolicyAckInput {
  exportId: string;
  policyId: string;
  policyVersion: number;
  policyDigest: string;
  scopeDigest: string;
  /** Absent means loaded; a value means the hook refused the export for that reason. */
  error?: PolicyLoadError;
}

export const policyAckData = (input: PolicyAckInput) => compact({
  event: input.error ? "rejected" : "loaded",
  export_id: input.exportId, policy_id: input.policyId, policy_version: input.policyVersion,
  policy_digest: input.policyDigest, scope_digest: input.scopeDigest,
  load_result: input.error ? "rejected" : "loaded",
  error: input.error,
});

/** SHA-256 hex of a policy's canonical JSON. */
export const digestPolicy = (policy: unknown): string => createHash("sha256").update(canonical(policy), "utf8").digest("hex");

export interface CapabilityProofInput {
  adapterVersion: string;
  hostVariant: string;
  actionType: string;
  phase: "pre_action" | "after_action";
  requiredFields: string[];
  /** `fixture/<digest>` for a local fixture run, so a fixture is never read as live. */
  fixtureVersion: string;
  passed: boolean;
  /** `source_receipt_hash` of each fixture receipt (the allow fixture and, for a before-action
   *  cell, the deny fixture) this proof stands on. The workspace resolves them against the
   *  receipts it accepted for this installation, so they are sent only once those receipts
   *  were delivered. */
  proofDigests?: string[];
}

export const capabilityProofData = (input: CapabilityProofInput) => ({
  event: "proof", connector: "scopebond-hook", adapter_version: input.adapterVersion, host_variant: input.hostVariant,
  action_type: input.actionType, phase: input.phase === "pre_action" ? "pre" : "after",
  required_fields: input.requiredFields.slice(0, 100).map((f) => f.slice(0, 200)),
  fixture_version: input.fixtureVersion.slice(0, 200), proof_result: input.passed ? "verified" : "failed",
  ...(input.proofDigests && input.proofDigests.length > 0
    ? { proof_digests: [...new Set(input.proofDigests.filter((d) => /^[0-9a-f]{64}$/.test(d)))].slice(0, 100) } : {}),
});

// ---- typed operations for tool_intent / tool_outcome -------------------------------------------

/** What the hook saw about one dispatched action, before reduction to an operation. */
export interface DispatchedAction {
  action_type: string;
  params: Record<string, unknown>;
}

export const REFERENCE_SET_VERSION = "hook-1";
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;
// eslint-disable-next-line security/detect-unsafe-regex -- linear: one unbounded quantifier (its overlap with the last character costs one step back), and the lookahead bounds the input to 253 characters
export const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const PROGRAM_DESTRUCTIVE = new Set([
  "rm", "sudo", "doas", "shutdown", "reboot", "halt", "poweroff", "mkfs", "dd", "shred", "truncate", "unlink", "wipe", "srm",
  "del", "rd", "rmdir", "erase", "deltree", "format", "diskpart", "remove-item", "ri", "clear-content", "clc", "stop-computer", "restart-computer",
]);

/** A short identifier the scrubber leaves untouched: not a credential shape, not a blob. */
const plain = (value: string): boolean => SAFE_NAME.test(value) && scrubParam(value) === value;

const stringParam = (params: Record<string, unknown>, key: string): string | undefined =>
  typeof params[key] === "string" ? (params[key]) : undefined;

const CREDENTIAL_DIRS = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker"]);
const CREDENTIAL_FILES = new Set([".npmrc", ".pypirc", ".netrc", ".git-credentials"]);
const CI_FILES = new Set([".gitlab-ci.yml", ".gitlab-ci.yaml", "jenkinsfile", "azure-pipelines.yml", "azure-pipelines.yaml"]);
const GUARDRAIL_DIRS = new Set([".scopebond", ".claude", ".cursor", ".codex", ".husky", ".githooks"]);
const CREDENTIAL_EXT = /\.(key|pem|p12|pfx|jks|keystore)$/;

/** Trailing slashes removed by a scan, so no backtracking regex runs over a caller-supplied path. */
const trimTrailingSlashes = (s: string): string => {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return s.slice(0, end);
};

// Classified by path segment rather than by one large pattern: a path is caller-supplied, so
// nothing here can backtrack on it.
const pathClass = (path: string): "ordinary" | "credential" | "ci" | "guardrail" | "unknown" => {
  const p = path.replace(/\\/g, "/").toLowerCase();
  if (p === "") return "unknown";
  const segs = p.split("/");
  const base = segs[segs.length - 1];
  if (base === ".env" || base.startsWith(".env.") || CREDENTIAL_EXT.test(base) || CREDENTIAL_FILES.has(base) || segs.some((s) => CREDENTIAL_DIRS.has(s))) return "credential";
  if (CI_FILES.has(base) || segs.some((s, i) => s === ".circleci" || s === ".buildkite" || (s === ".github" && (segs[i + 1] === "workflows" || segs[i + 1] === "actions")))) return "ci";
  if (base === ".mcp.json" || segs.some((s, i) => GUARDRAIL_DIRS.has(s) || (s === ".git" && (segs[i + 1]?.startsWith("hooks") === true || segs[i + 1]?.startsWith("config") === true)))) return "guardrail";
  return "ordinary";
};

const isAbsolutePath = (p: string): boolean => /^([A-Za-z]:[\\/]|\/|\\\\|~)/.test(p);

export interface OperationContext {
  key: BindingKey;
  /** Working directory, used only to derive a keyed workspace-root id. */
  cwd: string;
  /** HEAD commit of the workspace repository, when readable; required for a git operation. */
  headSha?: string | null;
  /** Keyed id of the workspace repository. */
  repositoryId?: string;
  /** Read-only view of the local repository; the system git when absent. */
  probe?: GitProbe;
  /** Whether a pushed ref is protected under the loaded rules; the default names main, master and release/*. */
  isProtectedRef?: (ref: string) => boolean;
  /** Local files and environment the Cloudflare, database and network derivations read; the real ones when absent. */
  files?: FileProbe;
  env?: (name: string) => string | undefined;
}

/** The context the typed-operation builders take, from an operation context. */
export const typedContext = (context: OperationContext): TypedContext => ({
  key: context.key, cwd: context.cwd, repositoryId: context.repositoryId ?? "", referenceSetVersion: REFERENCE_SET_VERSION,
  ...(context.probe ? { probe: context.probe } : {}), ...(context.isProtectedRef ? { isProtectedRef: context.isProtectedRef } : {}),
  ...(context.files ? { files: context.files } : {}), ...(context.env ? { env: context.env } : {}),
});

/**
 * Reduce one dispatched action to its closed typed operation, or null when this hook
 * cannot describe it honestly (an unmapped tool, a git push whose HEAD is unreadable, a
 * host or tool name that is not a plain identifier). The request digest is the request
 * binding over the actual dispatch request, `{action_type, params}` exactly as evaluated.
 */
export function buildOperation(action: DispatchedAction, context: OperationContext): Record<string, unknown> | null {
  const { key } = context;
  const request_digest = key.requestDigest({ action_type: action.action_type, params: action.params });
  const common = { environment_class: "unknown", reference_set_version: REFERENCE_SET_VERSION, request_digest, digest_key_generation: key.generation };
  const params = action.params;
  switch (action.action_type) {
    case "shell.exec": {
      // Judge the name as typed: a credential shape is recognised by its case.
      const typed = (stringParam(params, "program") ?? "").replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat|com|ps1)$/i, "");
      const raw = typed.toLowerCase();
      const resolved = typed !== "" && plain(typed);
      return {
        type: "shell", resource_id: key.resourceId("shell", raw), ...common,
        canonical_program: resolved ? raw : "unresolved",
        destructive_class: !resolved ? "unknown" : PROGRAM_DESTRUCTIVE.has(raw) ? "unknown" : "none",
        resolution: resolved ? "resolved" : "unresolved",
      };
    }
    case "file.read": case "file.write": {
      const path = stringParam(params, "path") ?? "";
      const resolved = path !== "";
      const id = key.resourceId("file", path);
      return {
        type: "file", resource_id: id, ...common,
        verb: action.action_type === "file.read" ? "read" : "write",
        target_ids: [id], root_id: key.resourceId("root", context.cwd),
        resolution: resolved ? "resolved" : "unresolved", path_class: pathClass(path),
        ...(resolved ? { outside_root: isAbsolutePath(path) && !isInside(context.cwd, path) || /(^|[\\/])\.\.([\\/]|$)/.test(path) } : {}),
      };
    }
    case "git.push": {
      if (!context.repositoryId) return null;
      return gitPushOperation(params, typedContext(context), context.headSha, { action_type: action.action_type, params });
    }
    // A WebFetch reaches the mapper as host, path and method only. The typed network operation
    // needs the scheme and port, which only the raw tool call carries, so it is derived from that
    // request (deriveTypedOperations) and never guessed here: no request, no operation.
    case "net.fetch": return null;
    case "mcp.tool.call": {
      const server = stringParam(params, "server") ?? "";
      const tool = stringParam(params, "tool") ?? "";
      if (!plain(server) || !plain(tool)) return null;
      return {
        type: "mcp", resource_id: key.resourceId("mcp", `${server}\0${tool}`), ...common,
        server_id: server, tool_name: tool, manifest_version: "unversioned", operation_class: "unknown", resource_ids: [],
      };
    }
    default:
      return null;
  }
}

function isInside(root: string, path: string): boolean {
  const norm = (s: string): string => trimTrailingSlashes(s.replace(/\\/g, "/")).toLowerCase();
  const r = norm(root);
  const p = norm(path);
  return p === r || p.startsWith(`${r}/`);
}

/**
 * One operation (or null) per dispatched item of a tool call. A typed operation derived from
 * the actual request (git commit, package install, GitHub pull request or release) replaces
 * the plain one for the same item; every other item keeps the operation `buildOperation` gives it.
 */
export function operationsForCall(
  input: { dispatched: Array<{ action: DispatchedAction }>; request?: CallRequest },
  context: OperationContext & { requiredCheckPolicyVersion?: string; resolvePullRequest?: TypedContext["resolvePullRequest"]; packageManagerVersion?: TypedContext["packageManagerVersion"] },
): Array<Record<string, unknown> | null> {
  let typed = new Map<number, Record<string, unknown>>();
  try {
    typed = deriveTypedOperations({ ...input.request, dispatched: input.dispatched, redact: redactCommand }, {
      ...typedContext(context),
      ...(context.requiredCheckPolicyVersion ? { requiredCheckPolicyVersion: context.requiredCheckPolicyVersion } : {}),
      ...(context.resolvePullRequest ? { resolvePullRequest: context.resolvePullRequest } : {}),
      ...(context.packageManagerVersion ? { packageManagerVersion: context.packageManagerVersion } : {}),
    });
  } catch { /* a derivation that fails leaves the plain operations */ }
  return input.dispatched.map((item, index) => typed.get(index) ?? buildOperation(item.action, context));
}

export const intentData = (operation: Record<string, unknown>) => ({
  event: "requested", operation, request_digest: operation.request_digest,
});

export type ExitCategory = "ok" | "error" | "timeout" | "cancelled" | "unknown";

export const outcomeData = (operation: Record<string, unknown>, exit: ExitCategory, adapterVersion: string, durationMs?: number) => compact({
  event: exit === "ok" ? "completed" : "failed", operation, exit_category: exit, adapter_version: adapterVersion.slice(0, 200),
  duration_ms: durationMs === undefined ? undefined : Math.max(0, Math.min(86_400_000, Math.round(durationMs))),
});
