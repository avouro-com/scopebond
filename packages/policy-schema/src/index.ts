// @scopebond/policy-schema — ships the JSON Schemas, vocabulary constants, and
// vectors. Runtime validation is left to consumers (e.g. ajv); this package is
// the canonical source of the schema and the enumerations.

import policySchemaDocument from "../schema/policy.schema.json" with { type: "json" };
import actionSchemaDocument from "../schema/action.schema.json" with { type: "json" };
import receiptSchemaDocument from "../schema/receipt.schema.json" with { type: "json" };
import legacyReceiptSchemaDocument from "../schema/receipt-legacy.schema.json" with { type: "json" };
import observationSchemaDocument from "../schema/observation.schema.json" with { type: "json" };
import summarySchemaDocument from "../schema/summary.schema.json" with { type: "json" };
import { canonical } from "./canonical.js";
export { canonical } from "./canonical.js";
export {
  actionRegistry, TAXONOMY_VERSION, getActionType, validateActionParams,
} from "./registry.js";
export type {
  ActionRegistry, ActionType, ActionParameter, ParameterType, RiskClass, ParamValidation,
} from "./registry.js";

export const policySchema = policySchemaDocument as Record<string, unknown>;
export const actionSchema = actionSchemaDocument as Record<string, unknown>;
export const receiptSchema = receiptSchemaDocument as Record<string, unknown>;
export const legacyReceiptSchema = legacyReceiptSchemaDocument as Record<string, unknown>;
export const observationSchema = observationSchemaDocument as Record<string, unknown>;
export const summarySchema = summarySchemaDocument as Record<string, unknown>;

// Summary record (scopebond:summary v1, evidence class "summary"): a signed stand-in for routine receipts when they are
// sent, with an RFC 9162 root over the receipts it covers. Receipts are unchanged and every action keeps its own. The
// signature covers the domain below followed by the RFC 8785 canonical payload, with the key that signs the receipts.
export const SUMMARY_TYPE = "scopebond:summary";
export const SUMMARY_VERSION = "1.0";
export const SUMMARY_DOMAIN = "scopebond:summary/v1\n";
/** The only results a summary may count: a denied, overridden, approved or timed-out action is always sent in full. */
export const SUMMARY_RESULTS = ["allow", "not_evaluated"] as const;
export const SUMMARY_LIMITS = { maxCounts: 500, maxDedupe: 500, maxReceipts: 1_000_000 } as const;

// Observation envelope (scopebond:observation v1): a separate, closed envelope for
// lifecycle, health, policy-acknowledgement and independently sourced outcome
// observations. Receipts are unchanged. The signature covers the domain below followed
// by the RFC 8785 canonical payload; observation_hash is the SHA-256 of the same bytes.
export const OBSERVATION_TYPE = "scopebond:observation";
export const OBSERVATION_VERSION = "1.0";
export const OBSERVATION_DOMAIN = "scopebond:observation/v1\n";
export const SOURCE_RECEIPT_DOMAIN = "scopebond:source-receipt/v1\n";
export const OBSERVATION_KINDS = [
  "session", "capability", "health", "policy_ack", "tool_intent",
  "tool_outcome", "platform_outcome", "verification", "integrity", "export",
] as const;
export const OBSERVATION_LIMITS = {
  maxBatchItems: 100,
  maxObservationBytes: 16 * 1024,
  maxBatchBodyBytes: 1024 * 1024,
} as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

/** The exact string whose UTF-8 bytes an observation signature (and observation_hash) covers. */
export const observationSigningInput = (payload: Record<string, unknown>): string =>
  OBSERVATION_DOMAIN + canonical(payload);

export const VOCABULARY_VERSION = "1.0";
export const EVIDENCE_VERSION = "1.0";
export const CANONICALIZATION = "RFC8785";
export const REDACTION_PROFILE = "scopebond:minimized-intent/v1";

export const CLAUSE_TYPES = [
  "spend_limit", "rate_limit",
  "address_allowlist", "address_denylist", "contract_allowlist",
  "endpoint_allowlist", "endpoint_denylist", "action_allowlist",
  "time_window", "require_approval", "sequence", "oracle_condition", "key_policy",
  "force_push_guard",
] as const;

export const CLAUSE_MODES = ["enforce", "monitor", "require_approval"] as const;

export const REALTIME_RESULTS = ["allow", "deny", "approved", "timeout", "not_evaluated"] as const;
export const EXECUTION_STATES = [
  "simulated", "observed_not_evaluated", "denied", "allowed_pending",
  "cooperative_allow",
  "executed", "failed", "outcome_unknown",
] as const;

// Evidence classes (§15 / D65): how strong a receipt's evidence is. Additive
// payload field; the verifier never upgrades an explicitly set class.
export const EVIDENCE_CLASSES = ["signed_intent", "pep_authorized", "boundary"] as const;
export const BOUNDARY_GATES = ["merge", "deploy", "egress", "platform_event"] as const;
export const ATTRIBUTION_KINDS = ["asserted", "inferred"] as const;

// The coverage buckets a policy resolves into (POLICY_VOCABULARY.md §4).
export const COVERAGE_BUCKETS = ["prevented", "covered", "refused"] as const;

export type ClauseType = (typeof CLAUSE_TYPES)[number];
export type ClauseMode = (typeof CLAUSE_MODES)[number];
export type RealtimeResult = (typeof REALTIME_RESULTS)[number];
export type ExecutionState = (typeof EXECUTION_STATES)[number];
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];
export type BoundaryGate = (typeof BOUNDARY_GATES)[number];
export type AttributionKind = (typeof ATTRIBUTION_KINDS)[number];
