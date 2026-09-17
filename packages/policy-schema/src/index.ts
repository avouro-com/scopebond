// @scopebond/policy-schema — ships the JSON Schemas, vocabulary constants, and
// vectors. Runtime validation is left to consumers (e.g. ajv); this package is
// the canonical source of the schema and the enumerations.

import policySchemaDocument from "../schema/policy.schema.json" with { type: "json" };
import actionSchemaDocument from "../schema/action.schema.json" with { type: "json" };
import receiptSchemaDocument from "../schema/receipt.schema.json" with { type: "json" };
import legacyReceiptSchemaDocument from "../schema/receipt-legacy.schema.json" with { type: "json" };
export { canonical } from "./canonical.js";

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
] as const;

export const CLAUSE_MODES = ["enforce", "monitor", "require_approval"] as const;

export const REALTIME_RESULTS = ["allow", "deny", "approved", "timeout", "not_evaluated"] as const;
export const EXECUTION_STATES = [
  "simulated", "observed_not_evaluated", "denied", "allowed_pending",
  "cooperative_allow",
  "executed", "failed", "outcome_unknown",
] as const;

// The coverage buckets a policy resolves into (POLICY_VOCABULARY.md §4).
export const COVERAGE_BUCKETS = ["prevented", "covered", "refused"] as const;

export type ClauseType = (typeof CLAUSE_TYPES)[number];
export type ClauseMode = (typeof CLAUSE_MODES)[number];
export type RealtimeResult = (typeof REALTIME_RESULTS)[number];
export type ExecutionState = (typeof EXECUTION_STATES)[number];
