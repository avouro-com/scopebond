// The typed MCP adapter: the closed `mcp` operation for one `tools/call`, built from the
// request the proxy actually dispatches, plus the decision an enforcing adapter takes on it.
//
// What is bound, and from where:
//   server        the configured server id of this proxy
//   tool          the tool name in the dispatched request
//   revision      the pinned manifest hash, and only while the upstream's live tool list still
//                 hashes to it; a tool list that changed since it was pinned is `unverified`
//   class         read_only or mutation from the pinned manifest, `unknown` for a tool it does
//                 not list or a revision that no longer matches
//   resources     opaque ids of the values found at the argument paths the pinned manifest
//                 names for that tool, read from the dispatched arguments themselves
//   digest        an HMAC over the canonical dispatched request under the installation-local
//                 key; the proxy forwards a copy of exactly what was digested
//
// A server or tool manifest says what a tool is, never which resource a call touches, so it
// cannot by itself authorize a resource-specific call: with `requireResourceBinding`, an
// enforcing adapter denies a call whose resources it could not bind, or that are not in the
// approved set for their kind. In monitor mode nothing is denied; unknown facts are recorded
// as unknown.

import { createHash, createHmac } from "node:crypto";
import { canonical } from "@scopebond/policy-schema/canonical";
import { SOURCE_RECEIPT_DOMAIN } from "@scopebond/policy-schema";

/** Request binding and keyed opaque ids. The hook's binding key satisfies this structurally. */
export interface RequestBinder {
  /** Opaque id of the key generation; safe to upload. */
  readonly generation: string;
  /** HMAC-SHA-256 of `scopebond:request-binding/v1\n` + the canonical request, as 64 hex. */
  requestDigest(request: unknown): string;
  /** A keyed opaque id for a resource. */
  resourceId(kind: string, value: string): string;
}

export const REQUEST_BINDING_DOMAIN = "scopebond:request-binding/v1\n";
const RESOURCE_ID_DOMAIN = "scopebond:resource-id/v1\n";
const KEY_GENERATION_DOMAIN = "scopebond:request-binding-key/v1\n";

/** The same binder the hook builds from the installation-local key: identical digests and ids
 *  for identical input, so an MCP proxy and a hook on one installation correlate. */
export function requestBinderFromHex(hex: string): RequestBinder {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new TypeError("invalid request-binding key");
  const key = Buffer.from(hex, "hex");
  const mac = (text: string): string => createHmac("sha256", key).update(text, "utf8").digest("hex");
  return {
    generation: `bk_${createHash("sha256").update(KEY_GENERATION_DOMAIN).update(key).digest("hex").slice(0, 16)}`,
    requestDigest: (request) => mac(REQUEST_BINDING_DOMAIN + canonical(request)),
    resourceId: (kind, value) => `sbr_${mac(`${RESOURCE_ID_DOMAIN}${kind}\0${value}`).slice(0, 32)}`,
  };
}

/** What the adapter hands an observation outbox. The hook's `ObservationEmitter.emit` takes
 *  exactly this, so the hook's outbox is a sink; any other implementation works too. */
export interface ObservationDraft {
  kind: "tool_intent" | "tool_outcome";
  occurredAt: number;
  sessionId?: string;
  parentActionId?: string;
  sourceReceiptHash?: string;
  data: Record<string, unknown>;
}
export interface ObservationSink { emit(draft: ObservationDraft): unknown }

export type OperationClass = "read_only" | "mutation" | "unknown";
export type ExitCategory = "ok" | "error" | "timeout" | "cancelled" | "unknown";

/** One tool of a pinned manifest. `resources` names the dispatched-argument paths (dotted,
 *  for example `repository` or `target.id`) whose values are the resources the call touches. */
export interface PinnedTool {
  operation_class: "read_only" | "mutation";
  resources?: Array<{ arg: string; kind: string }>;
}

/** A reviewed description of one upstream server, tied to the tool list it was reviewed
 *  against. `hash` is `manifestHash(tools)` of that list. */
export interface PinnedManifest {
  hash: string;
  tools: Record<string, PinnedTool>;
}

export interface TypedAdapterConfig {
  /** `enforce` denies before dispatch what it cannot bind; `monitor` records and forwards. */
  mode: "enforce" | "monitor";
  manifest?: PinnedManifest;
  /** Deny (enforce) a mutation, or a tool that declares resources, whose resources could not
   *  be bound from the dispatched arguments or are not approved. */
  requireResourceBinding?: boolean;
  /** Approved raw resource values per kind. Under `requireResourceBinding` a kind with no
   *  entry approves nothing. */
  approvedResources?: Record<string, string[]>;
  binder: RequestBinder;
  sink?: ObservationSink;
  /** How long a verified tool-list hash is trusted before it is read again. Default 60 s. */
  manifestRecheckMs?: number;
  referenceSetVersion?: string;
}

/** SHA-256 of a tool list: the canonical form of each tool's name, description, input schema
 *  and annotations, in name order. Presentation-only fields do not change it. */
export function manifestHash(tools: unknown[]): string {
  const norm = tools
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map((t) => ({ name: t.name ?? null, description: t.description ?? null, inputSchema: t.inputSchema ?? null, annotations: t.annotations ?? null }))
    .sort((a, b) => jsonString(a.name).localeCompare(jsonString(b.name)));
  return `sha256:${createHash("sha256").update(canonical(norm)).digest("hex")}`;
}

/** `String(v)` for a parsed JSON value — the same text for a string, number, boolean, null, array or plain
 *  object — without calling the value's own `toString`/`valueOf`: parsed JSON with a "toString" key
 *  (`{"toString": 1}`) made String() throw. Internal; not exported from the package. */
export function jsonString(v: unknown): string {
  switch (typeof v) {
    case "string": return v;
    case "object":
      if (v === null) return "null";
      return Array.isArray(v) ? v.map((el: unknown) => (el == null ? "" : jsonString(el))).join(",") : "[object Object]";
    default: return String(v);
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

/**
 * What is wrong with a typed adapter config read from JSON, in plain words, or null when it has the documented shape:
 * `mode` "monitor" or "enforce"; optional `requireResourceBinding` (boolean), `approvedResources` (an object of string
 * lists), `manifest` ({ hash: string, tools: { <name>: { operation_class: "read_only" | "mutation", resources?: [{ arg, kind }] } } }),
 * `manifestRecheckMs` (a whole number of milliseconds, 0 or more) and `referenceSetVersion` (string). A config that fails
 * this is refused, never read loosely: a value of the wrong type could change what an allowlist means.
 */
export function typedConfigProblem(raw: unknown): string | null {
  if (!isPlainObject(raw)) return "the typed config must be a JSON object";
  if (raw.mode !== "monitor" && raw.mode !== "enforce") return '"mode" must be "monitor" or "enforce"';
  if (raw.requireResourceBinding !== undefined && typeof raw.requireResourceBinding !== "boolean") return '"requireResourceBinding" must be true or false';
  if (raw.approvedResources !== undefined) {
    if (!isPlainObject(raw.approvedResources)) return '"approvedResources" must be an object of lists, for example { "repository": ["owner/name"] }';
    for (const [kind, list] of Object.entries(raw.approvedResources)) {
      if (!isStringList(list)) return `"approvedResources"."${kind}" must be a list of strings, for example ["owner/name"]`;
    }
  }
  if (raw.manifest !== undefined) {
    const manifest = raw.manifest;
    if (!isPlainObject(manifest) || typeof manifest.hash !== "string" || !isPlainObject(manifest.tools)) return '"manifest" must be { "hash": "sha256:…", "tools": { … } }';
    for (const [name, tool] of Object.entries(manifest.tools)) {
      if (!isPlainObject(tool) || (tool.operation_class !== "read_only" && tool.operation_class !== "mutation")) return `"manifest"."tools"."${name}"."operation_class" must be "read_only" or "mutation"`;
      if (tool.resources !== undefined && !(Array.isArray(tool.resources) && tool.resources.every((r) => isPlainObject(r) && typeof r.arg === "string" && r.arg !== "" && typeof r.kind === "string" && r.kind !== ""))) {
        return `"manifest"."tools"."${name}"."resources" must be a list of { "arg": "…", "kind": "…" }`;
      }
    }
  }
  if (raw.manifestRecheckMs !== undefined && !(typeof raw.manifestRecheckMs === "number" && Number.isSafeInteger(raw.manifestRecheckMs) && raw.manifestRecheckMs >= 0)) return '"manifestRecheckMs" must be a whole number of milliseconds, 0 or more';
  if (raw.referenceSetVersion !== undefined && typeof raw.referenceSetVersion !== "string") return '"referenceSetVersion" must be a string';
  return null;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/;
export const UNVERIFIED = "unverified";
export const MAX_RESOURCES = 100;

/** The value(s) at a dotted path of the dispatched arguments; undefined when absent or not
 *  a string, number, or list of them. */
function valuesAt(args: unknown, path: string): string[] | undefined {
  let node: unknown = args;
  for (const part of path.split(".")) {
    if (!node || typeof node !== "object" || Array.isArray(node) || !Object.hasOwn(node, part)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  const scalar = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : undefined);
  if (Array.isArray(node)) {
    const values = node.map(scalar);
    return node.length > 0 && values.every((v) => v !== undefined) ? (values) : undefined;
  }
  const one = scalar(node);
  return one === undefined ? undefined : [one];
}

export interface TypedDescription {
  /** The closed `mcp` operation, or null when the server or tool name is not a plain identifier. */
  operation: Record<string, unknown> | null;
  operation_class: OperationClass;
  /** Whether every resource the manifest declares for the tool was bound. */
  resources_bound: boolean;
  allow: boolean;
  /** Why an enforcing adapter denies; empty when it allows. Plain words, no raw values. */
  reasons: string[];
}

/**
 * Describe one dispatched `tools/call`. `dispatched` is the exact message the proxy will
 * forward (the caller passes a copy it owns), `manifestVerified` whether the upstream's live
 * tool list still hashes to the pinned revision.
 */
export function describeToolCall(
  config: TypedAdapterConfig, server: string, dispatched: { method?: string; params?: Record<string, unknown> }, manifestVerified: boolean,
): TypedDescription {
  const params = dispatched.params ?? {};
  const tool = typeof params.name === "string" ? params.name : "";
  const pinned = config.manifest && manifestVerified && Object.hasOwn(config.manifest.tools, tool) ? config.manifest.tools[tool] : undefined;
  const operation_class: OperationClass = pinned ? pinned.operation_class : "unknown";
  const reasons: string[] = [];
  if (!NAME.test(tool) || !NAME.test(server)) reasons.push("the server or tool name is not a plain identifier");
  if (!config.manifest) reasons.push("no pinned manifest is configured, so the tool is unknown");
  else if (!manifestVerified) reasons.push("the upstream tool list no longer matches the pinned manifest revision");
  else if (!pinned) reasons.push("the tool is not in the pinned manifest");

  // Bind resources from the dispatched arguments, never from anything the model summarised.
  const declared = pinned?.resources ?? [];
  const resourceIds: string[] = [];
  const bound: Array<{ kind: string; value: string }> = [];
  let resourcesBound = true;
  for (const { arg, kind } of declared) {
    const values = valuesAt(params.arguments, arg);
    if (!values) { resourcesBound = false; continue; }
    for (const value of values) { bound.push({ kind, value }); resourceIds.push(config.binder.resourceId(`mcp:${kind}`, value)); }
  }
  if (resourceIds.length > MAX_RESOURCES) { resourcesBound = false; resourceIds.length = 0; bound.length = 0; }
  if (config.requireResourceBinding) {
    const resourceSpecific = pinned && (pinned.operation_class === "mutation" || declared.length > 0);
    if (resourceSpecific && declared.length === 0) reasons.push("the tool is a mutation and its manifest names no resource to bind");
    else if (resourceSpecific && !resourcesBound) reasons.push("a resource the manifest names could not be read from the dispatched arguments");
    else if (resourceSpecific) {
      // Exact membership in a list of strings: an entry of any other shape (one string, written without brackets) approves
      // nothing, never every substring of itself.
      const approved: unknown = config.approvedResources ?? {};
      const listFor = (kind: string): unknown => (isPlainObject(approved) && Object.hasOwn(approved, kind) ? approved[kind] : undefined);
      const isApproved = (kind: string, value: string): boolean => {
        const list = listFor(kind);
        return Array.isArray(list) && list.some((v) => typeof v === "string" && v === value);
      };
      if (bound.some((b) => !isApproved(b.kind, b.value))) reasons.push("a bound resource is not in the approved set for its kind");
    }
  }

  const request = { action_type: "mcp.tool.call", server, request: { method: dispatched.method ?? "tools/call", params } };
  const operation = NAME.test(tool) && NAME.test(server) ? {
    type: "mcp", resource_id: config.binder.resourceId("mcp", `${server}\0${tool}`),
    environment_class: "unknown", reference_set_version: config.referenceSetVersion ?? "mcp-1",
    request_digest: config.binder.requestDigest(request), digest_key_generation: config.binder.generation,
    server_id: server, tool_name: tool, manifest_version: manifestVerified && config.manifest ? config.manifest.hash : UNVERIFIED,
    operation_class, resource_ids: resourceIds,
  } : null;
  return { operation, operation_class, resources_bound: resourcesBound, allow: reasons.length === 0, reasons };
}

/** `scopebond:source-receipt/v1\n` + canonical signed receipt, SHA-256: the hash that links an observation to its receipt. */
export const sourceReceiptHash = (receipt: unknown): string =>
  createHash("sha256").update(SOURCE_RECEIPT_DOMAIN + canonical(receipt), "utf8").digest("hex");

export const intentDraft = (operation: Record<string, unknown>, at: number, receipt: unknown): ObservationDraft => ({
  kind: "tool_intent", occurredAt: at, ...linkOf(receipt), data: { event: "requested", operation, request_digest: operation.request_digest, ...linkData(receipt) },
});

export const outcomeDraft = (operation: Record<string, unknown>, exit: ExitCategory, adapterVersion: string, at: number, startedAt: number, receipt: unknown): ObservationDraft => ({
  kind: "tool_outcome", occurredAt: at, ...linkOf(receipt),
  data: {
    event: exit === "ok" ? "completed" : "failed", operation, exit_category: exit, adapter_version: adapterVersion.slice(0, 200),
    duration_ms: Math.max(0, Math.min(86_400_000, Math.round(at - startedAt))), ...linkData(receipt),
  },
});

function actionIdOf(receipt: unknown): string | undefined {
  const id = (receipt as { payload?: { action_ref?: { action_id?: unknown } } } | undefined)?.payload?.action_ref?.action_id;
  return typeof id === "string" && id !== "" && id.length <= 200 ? id : undefined;
}
const linkOf = (receipt: unknown): { parentActionId?: string; sourceReceiptHash?: string } => {
  const parentActionId = actionIdOf(receipt);
  return parentActionId ? { parentActionId, sourceReceiptHash: sourceReceiptHash(receipt) } : {};
};
const linkData = (receipt: unknown): Record<string, string> => {
  const link = linkOf(receipt);
  return link.parentActionId ? { parent_action_id: link.parentActionId, source_receipt_hash: link.sourceReceiptHash as string } : {};
};
