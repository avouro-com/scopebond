// @scopebond/policy-schema — ships the JSON Schemas, vocabulary constants, and
// vectors. Runtime validation is left to consumers (e.g. ajv); this package is
// the canonical source of the schema and the enumerations.

import policySchemaDocument from "../schema/policy.schema.json" with { type: "json" };
import actionSchemaDocument from "../schema/action.schema.json" with { type: "json" };
import receiptSchemaDocument from "../schema/receipt.schema.json" with { type: "json" };
import legacyReceiptSchemaDocument from "../schema/receipt-legacy.schema.json" with { type: "json" };
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
